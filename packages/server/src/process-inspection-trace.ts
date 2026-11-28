import { createHash } from "node:crypto";
import {
	asUnknownRecord,
	type ExecutionInspectionRecord,
	type ProcessEvent,
	type ProcessTurnRecord,
} from "@leitwerk-dev/domain";
import type {
	InspectionTraceBlock,
	InspectionTraceMessage,
	PiSessionContentBlock,
} from "@leitwerk-dev/protocol";
import type { TraceInspectionCapture } from "./db/execution-inspection-repo.js";
import type { ReadonlyPiSessionTree } from "./pi-session-tree.js";

function fingerprintBlock(safe: PiSessionContentBlock): string {
	const hash = createHash("sha256");
	hash.update(safe.type);
	hash.update("\0");
	if (safe.type === "text") {
		hash.update(safe.text);
	} else if (safe.type === "thinking") {
		hash.update(safe.thinking);
		if (safe.redacted) hash.update("\0redacted");
	} else if (safe.type === "toolCall") {
		hash.update(safe.id);
		hash.update("\0");
		hash.update(safe.name);
		hash.update("\0");
		hash.update(JSON.stringify(safe.arguments));
	} else if (safe.type === "image") {
		hash.update(safe.mimeType);
		hash.update("\0");
		hash.update(safe.data);
	}
	return hash.digest("hex");
}

function blocks(messageId: string, content: unknown): InspectionTraceBlock[] {
	const raw =
		typeof content === "string"
			? [{ type: "text", text: content }]
			: Array.isArray(content)
				? content
				: [];
	const occurrences = new Map<string, number>();
	return raw.flatMap((value) => {
		const block = asUnknownRecord(value);
		if (!block) return [];
		let safe: PiSessionContentBlock;
		if (block.type === "text" && typeof block.text === "string")
			safe = { type: "text", text: block.text };
		else if (block.type === "thinking" && typeof block.thinking === "string")
			safe = {
				type: "thinking",
				thinking: block.thinking,
				...(block.redacted === true ? { redacted: true } : {}),
			};
		else if (
			block.type === "toolCall" &&
			typeof block.id === "string" &&
			typeof block.name === "string"
		)
			safe = {
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: asUnknownRecord(block.arguments) ?? {},
			};
		else if (
			block.type === "image" &&
			typeof block.data === "string" &&
			typeof block.mimeType === "string"
		)
			safe = { type: "image", data: block.data, mimeType: block.mimeType };
		else
			safe = {
				type: "text",
				text: `[Unsupported recorded ${String(block.type ?? "content")} block]`,
			};
		const fingerprint = fingerprintBlock(safe);
		const occurrence = occurrences.get(fingerprint) ?? 0;
		occurrences.set(fingerprint, occurrence + 1);
		const id = createHash("sha256")
			.update(`${messageId}\0${fingerprint}\0${occurrence}`)
			.digest("hex")
			.slice(0, 24);
		return [{ id: `block:${id}`, content: safe }];
	});
}

/** Preserve session roles, message order and model-facing blocks. @internal */
export function buildInspectionTraceMessages(input: {
	tree: ReadonlyPiSessionTree;
	record: ProcessTurnRecord;
	scope?: "execution" | "unassigned_branch";
	owner(entryId: string): string | null;
	captures: readonly (ExecutionInspectionRecord | TraceInspectionCapture)[];
	events: readonly ProcessEvent[];
}): InspectionTraceMessage[] {
	const messages: InspectionTraceMessage[] = [];
	const included = new Set<string>();
	const unassigned = input.scope === "unassigned_branch";
	const entries = unassigned
		? input.record.resultPiEntryId
			? input.tree.getBranch(input.record.resultPiEntryId)
			: []
		: input.tree.entries;
	const entryLinksByEntryId = new Map<string, { workerLeaseId: string; piTurnId: string }>();
	for (const item of input.captures) {
		if (
			item.fact.kind === "entry_link" &&
			item.fact.piTurnId &&
			!entryLinksByEntryId.has(item.fact.entryId)
		) {
			entryLinksByEntryId.set(item.fact.entryId, {
				workerLeaseId: item.workerLeaseId,
				piTurnId: item.fact.piTurnId,
			});
		}
	}
	const eventsByLeaseTurn = new Map<string, ProcessEvent[]>();
	if (entryLinksByEntryId.size > 0 && input.events.length > 0) {
		for (const event of input.events) {
			const leaseId = event.data.workerLeaseId;
			const turnId = event.data.turnId;
			if (typeof leaseId !== "string" || typeof turnId !== "string") continue;
			const key = `${leaseId}\0${turnId}`;
			const bucket = eventsByLeaseTurn.get(key);
			if (bucket) bucket.push(event);
			else eventsByLeaseTurn.set(key, [event]);
		}
	}
	for (const entry of entries) {
		if (unassigned) {
			if (input.owner(entry.id) !== null || !["message", "custom_message"].includes(entry.type))
				continue;
		} else if (input.owner(entry.id) !== input.record.id) continue;
		const message =
			entry.type === "message"
				? entry.message
				: entry.type === "custom_message"
					? { role: "user", content: entry.content }
					: {
							role: entry.type,
							content:
								entry.type === "compaction"
									? entry.summary
									: entry.type === "model_change"
										? `Model changed to ${entry.provider}/${entry.modelId}`
										: `Recorded ${entry.type.replaceAll("_", " ")} session entry`,
						};
		const record = message as unknown as Record<string, unknown>;
		const id = `entry:${entry.id}`;
		const link = entryLinksByEntryId.get(entry.id);
		const candidateEvents = link
			? (eventsByLeaseTurn.get(`${link.workerLeaseId}\0${link.piTurnId}`) ?? [])
			: [];
		const toolCallIds =
			candidateEvents.length > 0 && message.role === "assistant" && Array.isArray(record.content)
				? new Set(
						record.content.flatMap((block) =>
							block &&
							typeof block === "object" &&
							block.type === "toolCall" &&
							typeof block.id === "string"
								? [block.id]
								: [],
						),
					)
				: null;
		const aliases =
			candidateEvents.length > 0
				? candidateEvents
						.filter((event) => {
							if (message.role === "assistant")
								return (
									event.eventType === "pi.stream.delta" ||
									((event.eventType === "pi.tool.call" || event.eventType === "pi.tool.started") &&
										typeof event.data.toolCallId === "string" &&
										(toolCallIds?.has(event.data.toolCallId) ?? false))
								);
							return (
								message.role === "toolResult" &&
								(event.eventType === "pi.tool.result" || event.eventType === "pi.tool.completed") &&
								event.data.toolCallId === record.toolCallId
							);
						})
						.map((event) => `event:${event.eventSequence}`)
				: [];
		messages.push({
			id,
			entryId: entry.id,
			aliases,
			role: message.role,
			timestamp: entry.timestamp,
			blocks: blocks(id, record.content),
			toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : null,
			toolName: typeof record.toolName === "string" ? record.toolName : null,
			isError: record.isError === true,
		});
		included.add(entry.id);
	}
	if (unassigned) return messages;
	// Prompt evidence is available before the next session upload. Do not copy
	// inherited messages out of a model input into this execution's activity.
	for (const capture of input.captures) {
		if (capture.fact.kind !== "model_input") continue;
		for (const message of capture.fact.messages) {
			if (
				message.role !== "user" ||
				!message.entryId ||
				included.has(message.entryId) ||
				input.owner(message.entryId) !== input.record.id
			)
				continue;
			if (message.content.state !== "recorded" && message.content.state !== "redacted") continue;
			const id = `entry:${message.entryId}`;
			messages.push({
				id,
				entryId: message.entryId,
				aliases: [],
				role: message.role,
				timestamp: capture.timestamp,
				blocks: blocks(id, message.content.value),
				toolCallId: null,
				toolName: null,
				isError: false,
			});
			included.add(message.entryId);
		}
	}
	return messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

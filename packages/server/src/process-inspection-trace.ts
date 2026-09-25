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
import type { ReadonlyPiSessionTree } from "./pi-session-tree.js";

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
		const fingerprint = createHash("sha256").update(JSON.stringify(safe)).digest("hex");
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
	captures: readonly ExecutionInspectionRecord[];
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
		const link = input.captures.find(
			(item) => item.fact.kind === "entry_link" && item.fact.entryId === entry.id,
		);
		const piTurnId = link?.fact.kind === "entry_link" ? link.fact.piTurnId : null;
		const aliases =
			link && piTurnId
				? input.events
						.filter((event) => {
							if (event.data.workerLeaseId !== link.workerLeaseId || event.data.turnId !== piTurnId)
								return false;
							if (message.role === "assistant")
								return (
									event.eventType === "pi.stream.delta" ||
									(["pi.tool.call", "pi.tool.started"].includes(event.eventType) &&
										Array.isArray(record.content) &&
										record.content.some(
											(block) => block.type === "toolCall" && block.id === event.data.toolCallId,
										))
								);
							return (
								message.role === "toolResult" &&
								["pi.tool.result", "pi.tool.completed"].includes(event.eventType) &&
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

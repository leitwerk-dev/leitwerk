import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExecutionInspectionCapture, InspectionMessage } from "@leitwerk-dev/domain";

function messageKey(message: { role?: unknown; content?: unknown; toolCallId?: unknown }) {
	const content =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content;
	return JSON.stringify([
		message.role === "custom" ? "user" : message.role,
		content,
		message.toolCallId ?? null,
	]);
}

/** Observe the model-facing context without reading request options (which contain credentials). */
export function installPiInspection(
	session: AgentSession,
	emit: (capture: ExecutionInspectionCapture) => void,
	getPiTurnId: () => string = () => "unknown",
): () => void {
	const original = session.agent.streamFunction;
	if (typeof original !== "function") return () => {};
	// AgentSession's earlier, awaited listener persists message_end after notifying
	// its own subscribers. Observe agent-core after that listener has settled.
	const unsubscribe = session.agent.subscribe((event) => {
		if (event.type !== "message_end") return;
		const entry = session.sessionManager.getLeafEntry();
		if (!entry || (entry.type !== "message" && entry.type !== "custom_message")) return;
		const message =
			entry.type === "message" ? entry.message : { role: "custom", content: entry.content };
		if (messageKey(message) !== messageKey(event.message)) return;
		emit({
			id: `entry:${entry.id}`,
			version: 1,
			timestamp: entry.timestamp,
			fact: {
				kind: "entry_link",
				entryId: entry.id,
				piTurnId: getPiTurnId(),
				role: event.message.role,
			},
		});
	});
	session.agent.streamFunction = (model, context, options) => {
		const entries = session.sessionManager.getBranch();
		const byContent = new Map<string, Array<{ id: string; timestamp: number }>>();
		for (const entry of entries) {
			const message =
				entry.type === "message"
					? entry.message
					: entry.type === "custom_message"
						? { role: "user", content: entry.content }
						: null;
			if (!message) continue;
			const key = messageKey(message);
			const timestamp =
				"timestamp" in message && typeof message.timestamp === "number"
					? message.timestamp
					: Date.parse(entry.timestamp);
			byContent.set(key, [...(byContent.get(key) ?? []), { id: entry.id, timestamp }]);
		}
		const messages: InspectionMessage[] = context.messages.map((message) => {
			const matches = byContent.get(messageKey(message));
			const exact = matches?.filter((match) => match.timestamp === message.timestamp);
			const candidates = exact?.length ? exact : matches;
			return {
				entryId: candidates?.length === 1 ? candidates[0].id : null,
				role: message.role,
				...(message.role === "toolResult" ? { toolCallId: message.toolCallId } : {}),
				content: { state: "recorded", value: message.content },
			};
		});
		const capture: ExecutionInspectionCapture = {
			id: randomUUID(),
			version: 1,
			timestamp: new Date().toISOString(),
			fact: {
				kind: "model_input",
				boundaryEntryId: session.sessionManager.getLeafId(),
				model: {
					provider: model.provider,
					id: model.id,
					thinkingLevel: session.thinkingLevel ?? null,
				},
				systemPrompt: { state: "recorded", value: context.systemPrompt ?? "" },
				appendedInstructions: {
					state: "recorded",
					value: session.resourceLoader.getAppendSystemPrompt(),
				},
				contextFiles: {
					state: "recorded",
					value: session.resourceLoader
						.getAgentsFiles()
						.agentsFiles.map(({ path, content }) => ({ path, content })),
				},
				tools: {
					state: "recorded",
					value: (context.tools ?? []).map(({ name, description, parameters }) => ({
						name,
						description,
						parameters,
					})),
				},
				messages,
			},
		};
		emit(JSON.parse(JSON.stringify(capture)) as ExecutionInspectionCapture);
		return original.call(session.agent, model, context, options);
	};
	return () => {
		unsubscribe();
		session.agent.streamFunction = original;
	};
}

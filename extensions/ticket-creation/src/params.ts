import type {
	Codec,
	TicketCreationDestinationSnapshot,
	TicketCreationDestinationSummary,
} from "@leitwerk-dev/process-sdk";

export interface TicketParentContextSnapshot {
	focusedResult: string;
	parentPrompt: string;
	durableResults: readonly string[];
	additionalInstructions: string;
	capturedAt: string;
}

export interface TicketCreationParams {
	parentInstanceId: string;
	artifact: { kind: "turn_result" | "leaf_outcome"; turnRecordId?: string; leafEntryId?: string };
	focus: { kind: "whole_result" | "excerpt"; excerpt?: string };
	context: TicketParentContextSnapshot;
	additionalInstructions: string;
	toolName: string;
	initiatingActor: { id: string; kind: string; provider: string | null; displayName?: string };
	ticketDestination?: TicketCreationDestinationSnapshot;
	ticketDestinations?: readonly TicketCreationDestinationSummary[];
	ticketDestinationWarnings?: readonly string[];
	launchModelProfileId?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}
function string(value: unknown, label: string, required = false): string {
	if (typeof value !== "string" || (required && !value.trim()))
		throw new Error(`${label} must be ${required ? "a nonempty string" : "a string"}`);
	return value;
}
function optionalString(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : string(value, label);
}
function strings(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
	return value.map((item) => string(item, label));
}
function summary(value: unknown): TicketCreationDestinationSummary {
	const data = record(value, "ticket destination summary");
	return {
		id: string(data.id, "destination.id", true),
		displayName: string(data.displayName, "destination.displayName", true),
		...(data.group !== undefined ? { group: string(data.group, "destination.group") } : {}),
		...(data.description !== undefined
			? { description: string(data.description, "destination.description") }
			: {}),
	};
}
/** Validate only JSON representation. Destination semantics belong to the adapter. */
function jsonData(value: unknown, ancestors = new Set<unknown>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (!value || typeof value !== "object" || ancestors.has(value))
		throw new Error("destination.data must be JSON-serializable");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return Array.from(value, (item) => jsonData(item, ancestors));
		if (
			![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
			Object.getOwnPropertySymbols(value).length
		)
			throw new Error("destination.data must be JSON-serializable");
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, jsonData(item, ancestors)]),
		);
	} finally {
		ancestors.delete(value);
	}
}
function destination(value: unknown): TicketCreationDestinationSnapshot {
	const data = record(value, "ticket destination");
	return {
		summary: summary(data.summary),
		data: jsonData(data.data),
		...(data.agentContext !== undefined
			? { agentContext: string(data.agentContext, "destination.agentContext") }
			: {}),
	};
}

export const ticketCreationParamsCodec: Codec<TicketCreationParams> = {
	parse(value) {
		const data = record(value, "ticket parameters");
		const context = record(data.context, "immutable parent context");
		const artifact = record(data.artifact, "durable result artifact");
		if (artifact.kind !== "turn_result" && artifact.kind !== "leaf_outcome")
			throw new Error("Invalid artifact.kind");
		const turnRecordId = optionalString(artifact.turnRecordId, "artifact.turnRecordId");
		const leafEntryId = optionalString(artifact.leafEntryId, "artifact.leafEntryId");
		string(
			artifact.kind === "turn_result" ? turnRecordId : leafEntryId,
			"artifact identifier",
			true,
		);
		const focus = record(data.focus, "result focus");
		if (focus.kind !== "whole_result" && focus.kind !== "excerpt")
			throw new Error("Invalid focus.kind");
		const excerpt = optionalString(focus.excerpt, "focus.excerpt");
		if (focus.kind === "excerpt") string(excerpt, "focus.excerpt", true);
		const actor = record(data.initiatingActor, "initiating actor");
		if (data.ticketDestinations !== undefined && !Array.isArray(data.ticketDestinations))
			throw new Error("ticketDestinations must be an array");
		return {
			parentInstanceId: string(data.parentInstanceId, "parentInstanceId", true).trim(),
			artifact: {
				kind: artifact.kind,
				...(turnRecordId !== undefined ? { turnRecordId } : {}),
				...(leafEntryId !== undefined ? { leafEntryId } : {}),
			},
			focus: { kind: focus.kind, ...(excerpt !== undefined ? { excerpt } : {}) },
			context: {
				focusedResult: string(context.focusedResult, "context.focusedResult"),
				parentPrompt: string(context.parentPrompt, "context.parentPrompt"),
				durableResults: strings(context.durableResults, "context.durableResults"),
				additionalInstructions: string(
					context.additionalInstructions,
					"context.additionalInstructions",
				),
				capturedAt: string(context.capturedAt, "context.capturedAt"),
			},
			additionalInstructions:
				optionalString(data.additionalInstructions, "additionalInstructions") ?? "",
			toolName: string(data.toolName, "toolName", true).trim(),
			initiatingActor: {
				id: string(actor.id, "actor.id", true),
				kind: string(actor.kind, "actor.kind", true),
				provider: actor.provider === null ? null : string(actor.provider, "actor.provider", true),
				...(actor.displayName !== undefined
					? { displayName: string(actor.displayName, "actor.displayName") }
					: {}),
			},
			...(data.ticketDestination !== undefined
				? { ticketDestination: destination(data.ticketDestination) }
				: {}),
			...(Array.isArray(data.ticketDestinations)
				? { ticketDestinations: data.ticketDestinations.map(summary) }
				: {}),
			...(data.ticketDestinationWarnings !== undefined
				? {
						ticketDestinationWarnings: strings(
							data.ticketDestinationWarnings,
							"ticketDestinationWarnings",
						),
					}
				: {}),
			...(data.launchModelProfileId !== undefined
				? { launchModelProfileId: string(data.launchModelProfileId, "launchModelProfileId", true) }
				: {}),
		};
	},
	serialize: (value) => value,
};

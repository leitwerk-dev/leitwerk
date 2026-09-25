import type { PreparedTurnStart } from "./domain-model.js";

/** Completeness of one historical fact, independent of request/loading state. @internal */
export type InspectionEvidence<T> =
	| {
			/** @internal */
			state: "recorded" | "redacted";
			/** @internal */
			value: T;
	  }
	| {
			/** @internal */
			state: "not_recorded" | "unavailable" | "not_applicable";
			/** @internal */
			reason: string;
	  };

/** Immutable version supplied to a worker, not a declaration of possible consumption. @internal */
export interface InspectionProduct {
	/** @internal */
	name: string;
	/** @internal */
	producerTurnRecordId: string;
	/** @internal */
	entryId: string;
	/** @internal */
	content: InspectionEvidence<string>;
}

/** Model-facing content only. Renderer details and provider options are deliberately absent. @internal */
export interface InspectionMessage {
	/** Exact session identity when the conversion is unambiguous. @internal */
	entryId: string | null;
	/** @internal */
	role: string;
	/** @internal */
	toolCallId?: string;
	/** @internal */
	content: InspectionEvidence<unknown>;
}

/** Captured at the Pi stream function after context conversion and tool assembly. @internal */
export interface InspectionModelInput {
	/** @internal */
	kind: "model_input";
	/** @internal */
	boundaryEntryId: string | null;
	/** @internal */
	model: {
		/** @internal */
		provider: string;
		/** @internal */
		id: string;
		/** @internal */
		thinkingLevel: string | null;
	};
	/** @internal */
	systemPrompt: InspectionEvidence<string>;
	/** @internal */
	appendedInstructions: InspectionEvidence<string[]>;
	/** @internal */
	contextFiles: InspectionEvidence<
		Array<{
			/** @internal */
			path: string;
			/** @internal */
			content: string;
		}>
	>;
	/** @internal */
	tools: InspectionEvidence<
		Array<{
			/** @internal */
			name: string;
			/** @internal */
			description: string;
			/** @internal */
			parameters: unknown;
		}>
	>;
	/** Ordered references are retained per call; immutable content is stored once. @internal */
	messages: InspectionMessage[];
}

/** Versioned worker observation, correlated by the server to an accepted execution and lease. @internal */
export interface ExecutionInspectionCapture {
	/** Idempotency identity for this observation. @internal */
	id: string;
	/** @internal */
	version: 1;
	/** @internal */
	timestamp: string;
	/** @internal */
	fact:
		| InspectionModelInput
		| {
				/** @internal */
				kind: "supplied_context";
				/** @internal */
				origin: PreparedTurnStart | null;
				/** @internal */
				products: InspectionProduct[];
		  }
		| {
				/** @internal */
				kind: "product_consumed";
				/** @internal */
				supplyId: string;
				/** @internal */
				name: string;
		  }
		| {
				/** @internal */
				kind: "entry_link";
				/** @internal */
				entryId: string;
				/** @internal */
				piTurnId: string;
				/** @internal */
				role: string;
		  };
}

/** Compact lineage evidence excludes retained content. @internal */
export interface InspectionContextObservation {
	/** @internal */
	id: string;
	/** @internal */
	turnRecordId: string;
	/** @internal */
	fact:
		| Exclude<
				ExecutionInspectionCapture["fact"],
				InspectionModelInput | { kind: "supplied_context" }
		  >
		| {
				/** @internal */
				kind: "supplied_context";
				/** @internal */
				origin: PreparedTurnStart | null;
				/** @internal */
				products: Omit<InspectionProduct, "content">[];
		  };
}

/** Server-owned persisted observation. @internal */
export interface ExecutionInspectionRecord extends ExecutionInspectionCapture {
	/** @internal */
	sequence: number;
	/** @internal */
	instanceId: string;
	/** @internal */
	turnRecordId: string;
	/** @internal */
	startRecordId: string;
	/** Physical reporter, which can differ from the original accepting lease. @internal */
	workerLeaseId: string;
}

/** Redaction is retained as evidence, not silently presented as a complete capture. @internal */
export function redactInspectionEvidence<T>(value: T, redact: (text: string) => string): T {
	if (typeof value === "string") return redact(value) as T;
	if (Array.isArray(value)) return value.map((item) => redactInspectionEvidence(item, redact)) as T;
	if (!value || typeof value !== "object") return value;
	const original = value as Record<string, unknown>;
	const safe = Object.fromEntries(
		Object.entries(original).map(([key, item]) => [
			redact(key),
			redactInspectionEvidence(item, redact),
		]),
	);
	if (
		original.state === "recorded" &&
		JSON.stringify(original.value) !== JSON.stringify(safe.value)
	)
		safe.state = "redacted";
	return safe as T;
}

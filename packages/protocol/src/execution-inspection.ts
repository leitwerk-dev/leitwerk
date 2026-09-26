import type {
	InspectionEvidence,
	InspectionModelInput,
	InspectionProduct,
	PreparedTurnStart,
	ProcessEvent,
	ProcessTurnAnnotation,
	ProcessTurnRecord,
	TurnStartKind,
} from "@leitwerk-dev/domain";
import type { PiSessionContentBlock, TurnReasoningDetailResponseBody } from "./http-contracts.js";
import type { TurnUsageSnapshot } from "./primary-path-snapshot.js";

/** Exact source boundary; a null source means ownership was not recorded unambiguously. @internal */
export interface InspectionBoundary {
	/** @internal */
	entryId: string;
	/** @internal */
	turnRecordId: string | null;
}

/** Independent context dimensions, never inferred from the current workflow. @internal */
export interface ExecutionContextOrigin {
	/** @internal */
	authoredMode: InspectionEvidence<PreparedTurnStart["contextMode"]>;
	/** @internal */
	startTarget: InspectionEvidence<PreparedTurnStart["startTarget"]>;
	/** A recorded null means no inherited conversation, not no supplied inputs. @internal */
	conversation: InspectionEvidence<InspectionBoundary | null>;
	/** @internal */
	structuralPath: ProcessTurnRecord["pathType"];
	/** @internal */
	summary: string;
}

/** Compact execution facts can render independently of expanded reads. @internal */
export interface ExecutionInspectionSummary {
	/** @internal */
	instanceId: string;
	/** @internal */
	execution: Omit<ProcessTurnRecord, "turnResultMarkdown">;
	/** @internal */
	origin: ExecutionContextOrigin;
	/** @internal */
	startKind: InspectionEvidence<TurnStartKind>;
	/** @internal */
	model: InspectionEvidence<InspectionModelInput["model"]>;
	/** @internal */
	usage: TurnUsageSnapshot | null;
	/** @internal */
	previousTurnRecordId: string | null;
	/** @internal */
	nextTurnRecordId: string | null;
	/** @internal */
	modelInputCount: number;
}

/** Stable opaque block identities do not encode transcript text or array indexes. @internal */
export interface InspectionTraceBlock {
	/** @internal */
	id: string;
	/** @internal */
	content: PiSessionContentBlock;
}

/** One recorded message, preserving role and block order. @internal */
export interface InspectionTraceMessage {
	/** @internal */
	id: string;
	/** @internal */
	entryId: string | null;
	/** Durable live event targets that resolve to this committed message. @internal */
	aliases: string[];
	/** @internal */
	role: string;
	/** @internal */
	timestamp: string;
	/** @internal */
	blocks: InspectionTraceBlock[];
	/** @internal */
	toolCallId: string | null;
	/** @internal */
	toolName: string | null;
	/** @internal */
	isError: boolean;
}

/** Target validation never substitutes another execution. @internal */
export type InspectionTargetState =
	| {
			/** @internal */
			state: "available";
			/** @internal */
			itemId: string;
	  }
	| {
			/** @internal */
			state: "unavailable";
			/** @internal */
			reason: string;
	  };

/** Expanded trace reuses the existing sequenced live-history contract. @internal */
export interface ExecutionInspectionTrace extends TurnReasoningDetailResponseBody {
	/** Retained branch messages with unknown execution ownership, never inherited-context claims. @internal */
	unassignedMessages?: InspectionTraceMessage[];
	/** Durable events retain addressable evidence even without a committed session. @internal */
	events: ProcessEvent[];
	/** Applicable input, decision, and result evidence, including non-model executions. @internal */
	annotations: ProcessTurnAnnotation[];
	/** @internal */
	output: string | null;
	/** @internal */
	messages: InspectionTraceMessage[];
	/** @internal */
	target: InspectionTargetState | null;
	/** @internal */
	inheritedBoundary: InspectionBoundary | null;
}

/** @internal */
export interface InspectionProductVersion extends InspectionProduct {
	/** @internal */
	supplyId: string;
	/** @internal */
	consumed: boolean;
}

/** @internal */
export interface InspectionContextMessage {
	/** @internal */
	entryId: string | null;
	/** @internal */
	sourceTurnRecordId: string | null;
	/** @internal */
	role: string;
	/** Inherited messages link to their source; only local or transformed content is expanded. @internal */
	content: InspectionEvidence<unknown> | null;
}

/** @internal */
export interface InspectionInputRevision {
	/** @internal */
	id: string;
	/** @internal */
	timestamp: string;
	/** @internal */
	boundaryEntryId: string | null;
	/** @internal */
	model: InspectionModelInput["model"];
	/** @internal */
	messages: InspectionContextMessage[];
}

/** @internal */
export interface InspectionCompaction {
	/** @internal */
	entryId: string;
	/** @internal */
	firstKeptEntryId: string;
	/** @internal */
	summary: string;
}

/** @internal */
export interface ExecutionInspectionContext {
	/** Recorded local input messages also remain available for legacy executions. @internal */
	inputMessages: InspectionTraceMessage[];
	/** @internal */
	instanceId: string;
	/** @internal */
	turnRecordId: string;
	/** @internal */
	origin: ExecutionContextOrigin;
	/** Compact ancestry only; ancestor transcripts are never recursively loaded. @internal */
	ancestry: Array<{
		/** @internal */
		turnRecordId: string;
		/** @internal */
		turnId: string;
		/** @internal */
		boundaryEntryId: string;
	}>;
	/** @internal */
	products: InspectionEvidence<InspectionProductVersion[]>;
	/** @internal */
	modelInputs: InspectionEvidence<InspectionInputRevision[]>;
	/** @internal */
	compactions: InspectionCompaction[];
}

/** @internal */
export interface InspectionConfigurationRevision
	extends Omit<InspectionModelInput, "messages" | "kind"> {
	/** @internal */
	id: string;
	/** @internal */
	timestamp: string;
}

/** @internal */
export interface ExecutionInspectionConfiguration {
	/** @internal */
	instanceId: string;
	/** @internal */
	turnRecordId: string;
	/** @internal */
	revisions: InspectionEvidence<InspectionConfigurationRevision[]>;
	/** Only a navigation reference to the current workflow, never historical configuration. @internal */
	currentWorkflowTurnId: string;
}

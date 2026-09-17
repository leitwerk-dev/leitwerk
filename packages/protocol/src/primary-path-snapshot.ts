import type {
	ProcessSemanticEntryRefs,
	ProcessTurnAnnotation,
	ProcessTurnRecord,
	SemanticEntryRef,
	WorkerLease,
} from "@leitwerk-dev/domain";
import type { UsageSnapshot } from "./usage-snapshot.js";

/** @internal */
export interface PrimaryPathEntrySnapshot extends Record<string, unknown> {
	/** @internal */
	id: string;
	/** @internal */
	parentId: string | null;
	/** @internal */
	type: string;
	/** @internal */
	timestamp: string;
}

/** @internal */
export interface PrimaryPathDetailRailSnapshot {
	/** @internal */
	keyPoints: [];
	/** @internal */
	futureTurns: [];
	/** @internal */
	currentPosition: null;
}

/** @internal */
export interface PrimaryPathStreamingAssistantSnapshot {
	/** @internal */
	text: string;
	/** @internal */
	thinking: string;
	/** @internal */
	lastUpdatedAt: string | null;
}

/** @internal */
export interface PrimaryPathThinkingTraceItemSnapshot {
	/** @internal */
	kind: "thinking";
	/** @internal */
	text: string;
}

/** @internal */
export interface PrimaryPathToolCallTraceItemSnapshot {
	/** @internal */
	kind: "tool_call";
	/** @internal */
	toolCallId: string;
}

/** @internal */
export type PrimaryPathOperationalTraceSeverity = "info" | "success" | "warning" | "error";

/** @internal */
export interface PrimaryPathOperationalTraceItemSnapshot {
	/** @internal */
	kind: "operational_event";
	/** @internal */
	eventType: string;
	/** @internal */
	severity: PrimaryPathOperationalTraceSeverity;
	/** @internal */
	title: string;
	/** @internal */
	message: string;
	/** @internal */
	timestamp: string;
}

/** @internal */
export type PrimaryPathTraceItemSnapshot =
	| PrimaryPathThinkingTraceItemSnapshot
	| PrimaryPathToolCallTraceItemSnapshot
	| PrimaryPathOperationalTraceItemSnapshot;

/** @internal */
export interface PrimaryPathToolCallSnapshot {
	/** @internal */
	toolCallId: string;
	/** @internal */
	toolName: string;
	/** @internal */
	status: "running" | "completed";
	/** @internal */
	startedAt: string;
	/** @internal */
	completedAt: string | null;
	/** @internal */
	arguments: Record<string, unknown> | null;
	/** @internal */
	result: unknown;
	/** @internal */
	isError: boolean;
}

/** @internal */
export type TurnUsageSnapshot = UsageSnapshot;

/** @internal */
export interface PrimaryPathActiveTurnSnapshot {
	/** @internal */
	turnRecordId: string;
	/** @internal */
	turnId: string;
	/** @internal */
	turnType: ProcessTurnRecord["turnType"];
	/** @internal */
	pathType: ProcessTurnRecord["pathType"];
	/** @internal */
	startedAt: string;
	/** @internal */
	assistant: PrimaryPathStreamingAssistantSnapshot;
	/** @internal */
	toolCalls: PrimaryPathToolCallSnapshot[];
	/** @internal */
	traceItems: PrimaryPathTraceItemSnapshot[];
	/** @internal */
	usage: TurnUsageSnapshot | null;
	/** @internal */
	eventWindowTruncated: boolean;
}

/** @internal */
export interface PrimaryPathTurnStateSnapshot {
	/** @internal */
	currentTurnRecordId: string | null;
	/** @internal */
	workerState: WorkerLease["state"] | null;
	/** @internal */
	isStreaming: boolean;
	/** @internal */
	activeTurn: PrimaryPathActiveTurnSnapshot | null;
}

/** @internal */
export interface PrimaryPathSnapshot {
	/** @internal */
	instanceId: string;
	/** @internal */
	rebuiltAt: string;
	/** @internal */
	primaryPathEntries: PrimaryPathEntrySnapshot[];
	/** @internal */
	currentLeaf: SemanticEntryRef | null;
	/** @internal */
	semanticEntryRefs: ProcessSemanticEntryRefs;
	/** @internal */
	labels: Record<string, string>;
	/** @internal */
	turnAnnotations: ProcessTurnAnnotation[];
	/** @internal */
	detailRail: PrimaryPathDetailRailSnapshot;
	/** @internal */
	turnState: PrimaryPathTurnStateSnapshot;
}

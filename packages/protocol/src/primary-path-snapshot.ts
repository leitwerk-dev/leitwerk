import type {
	ProcessSemanticEntryRefs,
	ProcessTurnAnnotation,
	ProcessTurnRecord,
	SemanticEntryRef,
	WorkerLease,
} from "@leitwerk-dev/domain";
import type { UsageSnapshot } from "./usage-snapshot.js";

export interface PrimaryPathEntrySnapshot extends Record<string, unknown> {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
}

export interface PrimaryPathDetailRailSnapshot {
	keyPoints: [];
	futureTurns: [];
	currentPosition: null;
}

export interface PrimaryPathStreamingAssistantSnapshot {
	text: string;
	thinking: string;
	lastUpdatedAt: string | null;
}

export interface PrimaryPathThinkingTraceItemSnapshot {
	kind: "thinking";
	text: string;
}

export interface PrimaryPathToolCallTraceItemSnapshot {
	kind: "tool_call";
	toolCallId: string;
}

export type PrimaryPathOperationalTraceSeverity = "info" | "success" | "warning" | "error";

export interface PrimaryPathOperationalTraceItemSnapshot {
	kind: "operational_event";
	eventType: string;
	severity: PrimaryPathOperationalTraceSeverity;
	title: string;
	message: string;
	timestamp: string;
}

export type PrimaryPathTraceItemSnapshot =
	| PrimaryPathThinkingTraceItemSnapshot
	| PrimaryPathToolCallTraceItemSnapshot
	| PrimaryPathOperationalTraceItemSnapshot;

export interface PrimaryPathToolCallSnapshot {
	toolCallId: string;
	toolName: string;
	status: "running" | "completed";
	startedAt: string;
	completedAt: string | null;
	arguments: Record<string, unknown> | null;
	result: unknown;
	isError: boolean;
}

export type TurnUsageSnapshot = UsageSnapshot;

export interface PrimaryPathActiveTurnSnapshot {
	turnRecordId: string;
	turnId: string;
	turnType: ProcessTurnRecord["turnType"];
	pathType: ProcessTurnRecord["pathType"];
	startedAt: string;
	assistant: PrimaryPathStreamingAssistantSnapshot;
	toolCalls: PrimaryPathToolCallSnapshot[];
	traceItems: PrimaryPathTraceItemSnapshot[];
	usage: TurnUsageSnapshot | null;
	eventWindowTruncated: boolean;
}

export interface PrimaryPathTurnStateSnapshot {
	currentTurnRecordId: string | null;
	workerState: WorkerLease["state"] | null;
	isStreaming: boolean;
	activeTurn: PrimaryPathActiveTurnSnapshot | null;
}

export interface PrimaryPathSnapshot {
	instanceId: string;
	rebuiltAt: string;
	primaryPathEntries: PrimaryPathEntrySnapshot[];
	currentLeaf: SemanticEntryRef | null;
	semanticEntryRefs: ProcessSemanticEntryRefs;
	labels: Record<string, string>;
	turnAnnotations: ProcessTurnAnnotation[];
	detailRail: PrimaryPathDetailRailSnapshot;
	turnState: PrimaryPathTurnStateSnapshot;
}

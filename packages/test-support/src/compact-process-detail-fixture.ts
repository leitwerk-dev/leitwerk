import type {
	ProcessEvent,
	ProcessInput,
	ProcessInstance,
	ProcessProject,
	ProcessTurnAnnotation,
	ProcessTurnRecord,
	WorkerLease,
} from "@leitwerk-dev/domain";
import {
	createReadonlyEntryTree,
	type PiSessionEntry,
	type ProcessDetailUiSnapshotResponseBody,
	type TurnReasoningDetailResponseBody,
	type TurnTraceSnapshot,
} from "@leitwerk-dev/protocol";
import {
	buildProcessUiSnapshotProjections,
	buildTurnTraceIndexFromSession,
	type ReadonlyPiSessionTree,
} from "@leitwerk-dev/server/testing";

type LegacyProcessDetailFixture = ProcessDetailUiSnapshotResponseBody & {
	process: ProcessInstance;
	projects: ProcessProject[];
	inputs: ProcessInput[];
	events: ProcessEvent[];
	turnRecords: ProcessTurnRecord[];
	turnAnnotations: ProcessTurnAnnotation[];
	workerLease: WorkerLease | null;
	piSessionEntries: PiSessionEntry[];
};

const EMPTY_TRACE: TurnTraceSnapshot = {
	assistant: { text: "", thinking: "", lastUpdatedAt: null },
	toolCalls: [],
	traceItems: [],
	usage: null,
	piInput: null,
};

export function createCompactProcessDetailFixtureFactory() {
	const reasoningSourceByInstanceId = new Map<
		string,
		{
			signature: string | null;
			traceIndex: Record<string, TurnTraceSnapshot>;
		}
	>();

	function compact(input: unknown): ProcessDetailUiSnapshotResponseBody {
		const legacy = input as LegacyProcessDetailFixture;
		if (!Array.isArray(legacy.turnRecords)) {
			return input as ProcessDetailUiSnapshotResponseBody;
		}
		const sessionEntries = legacy.piSessionEntries ?? [];
		const entryTree = createReadonlyEntryTree(sessionEntries);
		const sessionTree = {
			...entryTree,
			treeFile: "ui-compact-fixture",
			header: null,
			getTree: () => [],
		} as unknown as ReadonlyPiSessionTree;
		const traceIndex = buildTurnTraceIndexFromSession({
			tree: sessionTree,
			turnRecords: legacy.turnRecords,
			events: legacy.events,
		});
		const signature =
			sessionEntries.length > 0 ? `test-session:${JSON.stringify(sessionEntries).length}` : null;
		const projections = buildProcessUiSnapshotProjections({
			process: legacy.process,
			turnRecords: legacy.turnRecords,
			turnAnnotations: legacy.turnAnnotations,
			events: legacy.events,
			inputs: legacy.inputs,
			selectedTurn: legacy.selectedTurn ?? null,
			primaryPathSnapshot: legacy.primaryPath,
			sessionTree,
		});
		const compactDetail: ProcessDetailUiSnapshotResponseBody = {
			...projections,
			instanceTree: legacy.instanceTree ?? { currentLeafId: null, nodes: [], edges: [] },
			leafOutcomeSnapshots: legacy.leafOutcomeSnapshots,
			questionRequests: [],
			toolApprovalRequests: [],
			processDisplayName: legacy.processDisplayName,
			processFlow: legacy.processFlow,
			definesLeafOutcome: legacy.definesLeafOutcome,
			selectedTurn: legacy.selectedTurn ?? null,
			scheduledAction: legacy.scheduledAction ?? null,
			modelConfiguration: legacy.modelConfiguration,
			runDetails: legacy.runDetails,
			launchConfiguration: legacy.launchConfiguration,
			actions: legacy.actions,
			toolRenderers: legacy.toolRenderers,
			persistedModelSelectionWarning: null,
			session: { signature },
			sessionTransfer: null,
		};
		reasoningSourceByInstanceId.set(projections.process.id, { signature, traceIndex });
		return compactDetail;
	}

	function reasoningResponse(
		instanceId: string,
		turnRecordId: string,
	): TurnReasoningDetailResponseBody {
		const source = reasoningSourceByInstanceId.get(instanceId);
		return {
			instanceId,
			turnRecordId,
			sessionSignature: source?.signature ?? null,
			reasoning: source?.traceIndex[turnRecordId] ?? EMPTY_TRACE,
		};
	}

	return { compact, reasoningResponse };
}

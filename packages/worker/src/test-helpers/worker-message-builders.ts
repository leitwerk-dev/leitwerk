import type { ProcessSemanticEntryRefKey } from "@leitwerk-dev/domain";
import type {
	InputDelivery,
	ProcessInstanceSnapshot,
	ProcessProjectSnapshot,
	ServerToWorkerMessage,
} from "@leitwerk-dev/worker-protocol";
import { createIpcMessage } from "@leitwerk-dev/worker-protocol";
import { baseEnvelope } from "./ipc-harness.js";

export type TestInputDelivery = Omit<InputDelivery, "receivedAt" | "source" | "kind" | "target"> & {
	receivedAt?: string;
	source?: string;
	kind?: string;
	target?: InputDelivery["target"];
};

const DEFAULT_PROJECT_SNAPSHOTS: ProcessProjectSnapshot[] = [
	{
		key: "c1",
		repoLocator: "https://example.com/r.git",
		baseBranch: "main",
		workBranch: "feat-1",
	},
];

export function toInputDelivery(input: TestInputDelivery): InputDelivery {
	return {
		inputId: input.inputId,
		sequence: input.sequence,
		source: input.source ?? "user",
		kind: input.kind ?? "user",
		target: input.target ?? null,
		receivedAt: input.receivedAt ?? new Date().toISOString(),
		bodyMarkdown: input.bodyMarkdown,
	};
}

export function workerStartMessage(
	instanceId: string,
	workerId: string,
	opts: {
		processSnapshot?: ProcessInstanceSnapshot;
		workspaceRoot: string;
		primaryTreeFile: string;
		resume: boolean;
		resumeLeafEntryId?: string | null;
		pendingInputs?: TestInputDelivery[];
		projectSnapshots?: ProcessProjectSnapshot[];
		turnResultMarkdownBySemanticRef?: Partial<Record<ProcessSemanticEntryRefKey, string>>;
		turnResultMarkdownByProduct?: Record<string, string>;
	},
): ServerToWorkerMessage {
	return createIpcMessage({
		...baseEnvelope(instanceId, workerId, "start-1"),
		type: "worker.start",
		payload: {
			processSnapshot: opts.processSnapshot ?? {},
			projectSnapshots: opts.projectSnapshots ?? DEFAULT_PROJECT_SNAPSHOTS,
			pendingInputs: (opts.pendingInputs ?? []).map(toInputDelivery),
			workerLeaseId: "lease-1",
			turnStart: {
				id: "start-1",
				instanceId,
				turnId: "automatic",
				turnType: "automatic",
				proposedTurnRecordId: "turn-record-1",
				startKind: "selected_turn",
				recoveryTurnRecordId: null,
				continuation: null,
				state: { kind: "starting", start: { kind: "automatic" } },
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
			bootstrap: { kind: "automatic" },
			treePaths: {
				primaryTreeFile: opts.primaryTreeFile,
				workspaceRoot: opts.workspaceRoot,
			},
			resume: opts.resume,
			...(opts.resumeLeafEntryId !== undefined
				? { resumeLeafEntryId: opts.resumeLeafEntryId }
				: {}),
			...(opts.turnResultMarkdownBySemanticRef
				? { turnResultMarkdownBySemanticRef: opts.turnResultMarkdownBySemanticRef }
				: {}),
			...(opts.turnResultMarkdownByProduct
				? { turnResultMarkdownByProduct: opts.turnResultMarkdownByProduct }
				: {}),
		},
	});
}

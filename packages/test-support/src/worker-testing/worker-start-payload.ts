import path from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { ResolvedTurnStart } from "@leitwerk-dev/domain";
import {
	createCanonicalPiResourceBundle,
	createTestConfigSnapshot,
	type InputDelivery,
	type ProcessInstanceSnapshot,
	type ProcessProjectSnapshot,
	sha256Digest,
	WORKER_API_VERSION,
	type WorkerCredentialMaterial,
	type WorkerStartPayload,
} from "@leitwerk-dev/worker-protocol";

type LlmStart = Extract<ResolvedTurnStart, { kind: "llm" }>;
type LlmModel = LlmStart["model"];

export interface TestLlmWorkerStartPayloadOptions {
	root: string;
	processSnapshot: ProcessInstanceSnapshot;
	projectSnapshots?: ProcessProjectSnapshot[];
	turnResultMarkdownBySemanticRef?: WorkerStartPayload["turnResultMarkdownBySemanticRef"];
	turnResultMarkdownByProduct?: WorkerStartPayload["turnResultMarkdownByProduct"];
	pendingInputs?: InputDelivery[];
	workerLeaseId?: string;
	startRecordId?: string;
	turnRecordId?: string;
	model?: LlmModel;
	credential?: WorkerCredentialMaterial | null;
	resume?: boolean;
	now?: string;
}

/** Builds a valid public LLM worker.start payload with canonical Pi resources. */
export function createTestLlmWorkerStartPayload(
	options: TestLlmWorkerStartPayloadOptions,
): WorkerStartPayload {
	const instanceId = options.processSnapshot.id ?? "proc_test";
	const model =
		options.model ??
		({
			profileId: "test",
			providerId: "openai",
			modelId: "test-model",
			thinkingLevel: "low",
		} satisfies LlmModel);
	const immutableFiles = [
		{
			path: "settings.json",
			content: Buffer.from('{"defaultProjectTrust":"never","packages":[]}\n'),
		},
		{ path: "models.json", content: Buffer.from('{"providers":{}}\n') },
	];
	const generated = {
		schemaVersion: 1,
		model,
		providerOptions: {},
		providerWorkerConfig: null,
		declaredCredentialPaths: ["auth.json"],
		compatibility: { workerApiVersion: WORKER_API_VERSION, piVersion: PI_VERSION },
		provenance: immutableFiles.map((file) => ({
			kind: "generated" as const,
			ownerExtensionId: null,
			packageName: null,
			snapshotPath: file.path,
			sha256: sha256Digest(file.content),
			size: file.content.byteLength,
		})),
	};
	const bundle = createCanonicalPiResourceBundle([
		...immutableFiles,
		{ path: "generated.json", content: Buffer.from(`${JSON.stringify(generated)}\n`) },
	]);
	const configSnapshot = createTestConfigSnapshot();
	configSnapshot.pi.agent_dir = path.join(options.root, "agent");
	configSnapshot.pi.model_profiles = [
		{
			id: model.profileId,
			provider: model.providerId,
			model_id: model.modelId,
			thinking_level: model.thinkingLevel,
		},
	];
	const now = options.now ?? "2025-01-01T00:00:00.000Z";
	return {
		processSnapshot: options.processSnapshot,
		projectSnapshots: options.projectSnapshots ?? [],
		turnResultMarkdownBySemanticRef: options.turnResultMarkdownBySemanticRef,
		turnResultMarkdownByProduct: options.turnResultMarkdownByProduct,
		workerLeaseId: options.workerLeaseId ?? "lease_1",
		turnStart: {
			id: options.startRecordId ?? "start_1",
			instanceId,
			turnId: options.processSnapshot.selectedTurnId ?? "run",
			turnType: "llm",
			proposedTurnRecordId: options.turnRecordId ?? "trn_1",
			startKind: "selected_turn",
			recoveryTurnRecordId: null,
			continuation: null,
			state: {
				kind: "starting",
				start: {
					kind: "llm",
					model,
					providerOptions: {},
					providerWorkerConfig: null,
					piResourceSnapshotDigest: bundle.digest,
					workerRuntimeProfileId: "default",
					piSettings: {},
				},
			},
			createdAt: now,
			updatedAt: now,
		},
		pendingInputs: options.pendingInputs ?? [],
		bootstrap: {
			kind: "llm",
			resourceBundle: {
				digest: bundle.digest,
				archiveBase64: Buffer.from(bundle.bytes).toString("base64"),
			},
			credential:
				options.credential === undefined
					? { providerId: model.providerId, revision: 1, values: { apiKey: "test-secret" } }
					: options.credential,
		},
		configSnapshot,
		treePaths: {
			primaryTreeFile: path.join(options.root, "tree", "primary.jsonl"),
			workspaceRoot: path.join(options.root, "workspace"),
			piResourceBundlesDir: path.join(options.root, "pi-resource-bundles"),
		},
		resume: options.resume ?? false,
	};
}

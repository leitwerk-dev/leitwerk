import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { ResolvedWorkerProcess } from "@leitwerk-dev/extension-runtime";
import { createTestProcessInstance } from "@leitwerk-dev/extension-runtime/testing";
import { llmTurn } from "@leitwerk-dev/process-sdk";
import { StubPiTreeHandleFactory } from "@leitwerk-dev/test-support/worker-testing";
import {
	createTestConfigSnapshot,
	type PiResourceBundle,
	WORKER_API_VERSION,
} from "@leitwerk-dev/worker-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	inspectPiTreeForPlanning,
	type PiTreeHandleOptions,
	type PiTreePlanningOptions,
} from "../pi-adapter.js";
import { createCanonicalPiResourceBundle, sha256Digest } from "../pi-resource-bundle.js";
import type { RunRootGitOps } from "../workspace/run-root.js";
import { nodeWorkerRuntimeScheduler } from "./adapters.js";
import { activatePreparedStart, bootstrapWorkerRuntime } from "./bootstrap.js";

const tempDirs: string[] = [];
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const bootstrapNow = "2026-02-03T04:05:06.000Z";
const bootstrapScheduler = {
	...nodeWorkerRuntimeScheduler,
	now: () => new Date(bootstrapNow),
};

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "runtime-bootstrap-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
});

function noProjectGitOps(): RunRootGitOps {
	return {
		async clone() {},
		async checkout() {},
		async createBranch() {},
		async branchExists() {
			return false;
		},
		async getHeadSha() {
			return "test-sha";
		},
		async readFile() {
			return null;
		},
		async listFiles() {
			return [];
		},
		async writeFile(repoDir, filePath, content) {
			const targetPath = path.join(repoDir, filePath);
			mkdirSync(path.dirname(targetPath), { recursive: true });
			writeFileSync(targetPath, content, "utf8");
		},
	};
}

function managedBundle(model: {
	profileId: string;
	providerId: string;
	modelId: string;
	thinkingLevel: string;
}): PiResourceBundle {
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
			kind: "generated",
			ownerExtensionId: null,
			packageName: null,
			snapshotPath: file.path,
			sha256: sha256Digest(file.content),
			size: file.content.byteLength,
		})),
	};
	return createCanonicalPiResourceBundle([
		...immutableFiles,
		{ path: "generated.json", content: Buffer.from(`${JSON.stringify(generated)}\n`) },
	]);
}

class CapturingPiTreeHandleFactory extends StubPiTreeHandleFactory {
	readonly options: PiTreeHandleOptions[] = [];

	override inspectPrimaryTree(opts: PiTreePlanningOptions) {
		return inspectPiTreeForPlanning(opts);
	}

	override async createPrimaryTreeHandle(opts: PiTreeHandleOptions) {
		this.options.push(opts);
		return super.createPrimaryTreeHandle(opts);
	}
}

describe("bootstrapWorkerRuntime", () => {
	it("passes a code-defined Pi session working directory to the Pi handle factory", async () => {
		const root = tempDir();
		const workspaceRoot = path.join(root, "workspace");
		const treeFile = path.join(root, "trees", "primary.jsonl");
		const sessionTarget = path.join(root, "target");
		mkdirSync(sessionTarget, { recursive: true });
		const processSnapshot = createTestProcessInstance({
			id: "agt_session_cwd",
			processId: "session_cwd_process",
			selectedTurnId: "run",
			paramsJson: JSON.stringify({ workingDirectory: sessionTarget }),
			stateJson: JSON.stringify({}),
		});
		const resolvedWorkerProcess: ResolvedWorkerProcess<
			{ workingDirectory: string },
			Record<string, never>
		> = {
			// Bootstrap needs the authored tree semantics before start acceptance.
			processId: "session_cwd_process",
			startTurnId: "run",
			turns: new Map([
				[
					"run",
					{
						definition: llmTurn({
							description: "Run",
							availableTools: [],
							branchType: "primary",
							context: "fresh",
							prompt: async () => "run",
							turnEnd: { outcome: "done", params: {}, complete: true },
						}),
					},
				],
			]),
			definition: { startTurnId: "run", turns: new Map() },
			params: { workingDirectory: sessionTarget },
			state: {},
			piConfig: { sessionCwdTemplate: "{{{workingDirectory}}}" },
		};
		const piFactory = new CapturingPiTreeHandleFactory();
		process.env.PI_CODING_AGENT_DIR = path.join(root, "ambient-agent-dir");

		const model = {
			profileId: "test",
			providerId: "openai",
			modelId: "test",
			thinkingLevel: "low",
		};
		const bundle = managedBundle(model);
		const configSnapshot = createTestConfigSnapshot();
		configSnapshot.pi.agent_dir = path.join(root, "agent-root");
		configSnapshot.pi.model_profiles = [
			{
				id: model.profileId,
				provider: model.providerId,
				model_id: model.modelId,
				thinking_level: model.thinkingLevel,
			},
		];
		const bootstrapped = await bootstrapWorkerRuntime({
			instanceId: processSnapshot.id,
			payload: {
				processSnapshot,
				projectSnapshots: [],
				pendingInputs: [],
				configSnapshot,
				workerLeaseId: "lease-1",
				turnStart: {
					id: "start-1",
					instanceId: processSnapshot.id,
					turnId: "run",
					turnType: "llm",
					proposedTurnRecordId: "trn-1",
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
					createdAt: "",
					updatedAt: "",
				},
				bootstrap: {
					kind: "llm",
					resourceBundle: {
						digest: bundle.digest,
						archiveBase64: Buffer.from(bundle.bytes).toString("base64"),
					},
					credential: { providerId: "openai", revision: 1, values: { apiKey: "sk-test" } },
				},
				treePaths: { primaryTreeFile: treeFile, workspaceRoot },
				resume: false,
			},
			piFactory,
			gitOps: noProjectGitOps(),
			scheduler: bootstrapScheduler,
			resolveWorkerProcess: () => resolvedWorkerProcess,
		});

		expect(piFactory.options).toHaveLength(0);
		expect(process.env.PI_CODING_AGENT_DIR).toBe(path.join(root, "ambient-agent-dir"));
		const authPath = path.join(
			configSnapshot.pi.agent_dir,
			processSnapshot.id,
			"lease-1",
			"auth.json",
		);
		expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
			openai: { type: "api_key", key: "sk-test" },
		});
		expect(lstatSync(authPath).mode & 0o777).toBe(0o600);
		expect(bootstrapped.startPayload).toMatchObject({
			bootstrap: {
				credential: { providerId: "openai", revision: 1, values: {} },
			},
		});
		expect(bootstrapped.readyPayload.receipt).toMatchObject({
			readyAt: bootstrapNow,
			credentialRevision: 1,
			loadedResourceIds: ["settings.json", "models.json"],
			resolvedModel: { providerId: "openai", modelId: "test" },
			preparedStart: {
				pathType: "primary",
				contextMode: "fresh",
				startTarget: { kind: "root" },
				forkPiEntryId: null,
			},
		});
		await activatePreparedStart({
			instanceId: processSnapshot.id,
			piFactory,
			activation: bootstrapped.activation,
		});
		expect(piFactory.options[0]).toMatchObject({
			workspaceRoot,
			sessionCwd: sessionTarget,
			agentDir: path.dirname(authPath),
		});
		expect(process.env.PI_CODING_AGENT_DIR).toBe(path.join(root, "ambient-agent-dir"));
	});

	it("prepares a session-root receipt from the persisted tree without opening or mutating it", async () => {
		const root = tempDir();
		const workspaceRoot = path.join(root, "workspace");
		const treeFile = path.join(root, "trees", "primary.jsonl");
		mkdirSync(workspaceRoot, { recursive: true });
		mkdirSync(path.dirname(treeFile), { recursive: true });
		const treeContents = `${[
			{
				type: "session",
				version: 3,
				id: "root-review-session",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: workspaceRoot,
			},
			{
				type: "message",
				id: "root-user",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "Implement this" },
			},
			{
				type: "message",
				id: "primary-assistant",
				parentId: "root-user",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: { role: "assistant", content: "Implemented" },
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		writeFileSync(treeFile, treeContents, "utf8");
		const structuralState = {
			semanticEntryRefs: {
				rootEntry: { entryId: "root-user", turnRecordId: null },
				currentPrimaryPathLeaf: {
					entryId: "primary-assistant",
					turnRecordId: "trn_implement",
				},
				plan: null,
				review: null,
			},
		};
		const processSnapshot = createTestProcessInstance({
			id: "agt_root_review",
			processId: "root_review_process",
			selectedTurnId: "review",
			stateJson: JSON.stringify(structuralState),
		});
		const reviewTurn = llmTurn({
			description: "Review",
			availableTools: [],
			branchType: "root_branch",
			context: "full",
			startFrom: { kind: "session_root" },
			prompt: async () => "review",
			turnEnd: { outcome: "done", params: {}, complete: true },
		});
		const resolvedWorkerProcess: ResolvedWorkerProcess = {
			processId: "root_review_process",
			startTurnId: "review",
			turns: new Map([["review", { definition: reviewTurn }]]),
			definition: { startTurnId: "review", turns: new Map() },
			params: {},
			state: structuralState,
		};
		const model = {
			profileId: "test",
			providerId: "openai",
			modelId: "test",
			thinkingLevel: "low",
		};
		const bundle = managedBundle(model);
		const configSnapshot = createTestConfigSnapshot();
		configSnapshot.pi.agent_dir = path.join(root, "agent-root");
		configSnapshot.pi.model_profiles = [
			{
				id: model.profileId,
				provider: model.providerId,
				model_id: model.modelId,
				thinking_level: model.thinkingLevel,
			},
		];
		const piFactory = new CapturingPiTreeHandleFactory();

		const bootstrapped = await bootstrapWorkerRuntime({
			instanceId: processSnapshot.id,
			payload: {
				processSnapshot,
				projectSnapshots: [],
				pendingInputs: [],
				configSnapshot,
				workerLeaseId: "lease-root-review",
				turnStart: {
					id: "start-root-review",
					instanceId: processSnapshot.id,
					turnId: "review",
					turnType: "llm",
					proposedTurnRecordId: "trn-review",
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
					createdAt: "",
					updatedAt: "",
				},
				bootstrap: {
					kind: "llm",
					resourceBundle: {
						digest: bundle.digest,
						archiveBase64: Buffer.from(bundle.bytes).toString("base64"),
					},
					credential: { providerId: "openai", revision: 1, values: { apiKey: "sk-test" } },
				},
				treePaths: { primaryTreeFile: treeFile, workspaceRoot },
				resume: true,
				resumeLeafEntryId: "primary-assistant",
			},
			piFactory,
			gitOps: noProjectGitOps(),
			scheduler: bootstrapScheduler,
			resolveWorkerProcess: () => resolvedWorkerProcess,
		});

		expect(piFactory.options).toHaveLength(0);
		expect(readFileSync(treeFile, "utf8")).toBe(treeContents);
		expect(bootstrapped.readyPayload.receipt).toMatchObject({
			preparedStart: {
				pathType: "root_branch",
				contextMode: "full",
				startTarget: { kind: "root" },
				forkPiEntryId: null,
			},
		});
	});
});

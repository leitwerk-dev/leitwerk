import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	builtinPiProvider,
	type Codec,
	createEmptyStructuralProcessState,
	defineModelProvider,
	defineModelProviders,
	defineProcess,
	emptyParamsCodec,
	type LeitwerkExtensionModule,
	parseStructuralProcessState,
} from "@leitwerk-dev/process-sdk";
import {
	createIntegrationHarness,
	type IntegrationHarness,
} from "@leitwerk-dev/test-support/integration";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const structuralStateCodec: Codec<ReturnType<typeof createEmptyStructuralProcessState>> = {
	parse(value) {
		return parseStructuralProcessState(value);
	},
	serialize(value) {
		return value;
	},
};

const abortTurnDef = {
	id: "implement",
	description: "Implementation turn for abort-turn HTTP tests",
	availableTools: [],
	kind: "llm" as const,
	completionMode: "turn_end" as const,
	branchType: "primary" as const,
	context: "fresh" as const,
	prompt: async () => "Implement",
	outcomes: {},
	turnEnd: { outcome: "completed" as const, params: {}, complete: true },
};

const abortTurnProcess = defineProcess<
	Record<string, never>,
	ReturnType<typeof createEmptyStructuralProcessState>
>({
	id: "abort_turn_http_test_process",
	displayName: "Abort Turn HTTP Test Process",
	entry: "implement",
	turns: { implement: abortTurnDef },
	paramsCodec: emptyParamsCodec,
	stateCodec: structuralStateCodec,
	initialState() {
		return createEmptyStructuralProcessState();
	},
});

const abortTurnExtension: LeitwerkExtensionModule = {
	manifest: { id: "abort-turn-http-test", version: "0.1.0" },
	modelProviders: defineModelProviders((rawConfig) => [
		{
			definition: defineModelProvider({
				id: "abort-fixture-provider",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("ollama"),
				models: () => [{ modelId: "fixture-model", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
	]),
	setupCatalog(api) {
		api.registerProcess(abortTurnProcess);
	},
};

let harness: IntegrationHarness | undefined;
let tempRoot = "";

beforeAll(async () => {
	tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-abort-turn-http-"));
	harness = await createIntegrationHarness({
		extensionCatalog: buildExtensionCatalogFromModules([abortTurnExtension]),
		inProcessWorkers: false,
		configOverride(config) {
			config.pi.model_profiles = [
				{
					id: "abort-fixture-profile",
					provider: "abort-fixture-provider",
					model_id: "fixture-model",
					thinking_level: "off",
				},
			];
			config.storage.tree_files_dir = path.join(tempRoot, "trees");
			config.storage.process_workspaces_dir = path.join(tempRoot, "workspaces");
			mkdirSync(config.storage.tree_files_dir, { recursive: true });
			mkdirSync(config.storage.process_workspaces_dir, { recursive: true });
		},
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	if (harness) {
		await harness.ctx.app.close();
	}
	rmSync(tempRoot, { recursive: true, force: true });
});

function requireHarness(): IntegrationHarness {
	if (!harness) {
		throw new Error("expected integration harness");
	}
	return harness;
}

async function seedPreparedRunningLlmProcess() {
	const h = requireHarness();
	const process = h.ctx.deps.processes.create({
		processId: "abort_turn_http_test_process",
		selectedTurnId: null,
		lifecycleStatus: "discovered",
		defaultModelProfileId: "abort-fixture-profile",
		stateJson: JSON.stringify(createEmptyStructuralProcessState()),
	});
	const workerHandle = {
		workerId: "wk_abort_ok",
		instanceId: process.id,
		send() {},
		kill() {},
	};
	const getWorkerSpy = vi.spyOn(h.ctx.supervisor, "getWorker").mockReturnValue(workerHandle);
	const spawnWorkerSpy = vi.spyOn(h.ctx.supervisor, "spawnWorker").mockResolvedValue(workerHandle);
	const started = await h.ctx.deps.processEngine.startProcess(process.id, "implement");
	getWorkerSpy.mockRestore();
	spawnWorkerSpy.mockRestore();
	if (!started.ok) throw new Error(`Expected fixture start to succeed: ${started.message}`);
	const selected = h.ctx.deps.processes.getById(process.id);
	if (selected?.currentExecution?.kind !== "worker_start") {
		throw new Error("Expected prepared worker start");
	}
	const start = h.ctx.deps.turnStarts.getById(selected.currentExecution.id);
	if (!start || start.state.kind !== "starting" || start.state.start.kind !== "llm") {
		throw new Error("Expected prepared LLM start");
	}
	const lease = h.ctx.deps.leases.create({
		instanceId: process.id,
		workerId: workerHandle.workerId,
		state: "busy",
	});
	h.ctx.deps.turnStarts.compareAndSetState({
		id: start.id,
		expectedKind: "starting",
		state: {
			kind: "accepted",
			start: start.state.start,
			turnRecordId: start.proposedTurnRecordId,
			acceptedWorkerLeaseId: lease.id,
		},
	});
	h.ctx.deps.turnRecords.create({
		id: start.proposedTurnRecordId,
		instanceId: process.id,
		turnId: "implement",
		turnType: "llm",
		status: "running",
		attemptNumber: 1,
		turnStartRecordId: start.id,
		acceptedWorkerLeaseId: lease.id,
		pathType: "primary",
		forkPiEntryId: "primary-leaf",
		startedAt: "2026-04-25T10:00:01.500Z",
	});
	return { process, turnRecordId: start.proposedTurnRecordId, workerHandle };
}

function seedProcess(input: {
	turnRecordId: string;
	lifecycleStatus: "active" | "error" | "completed";
	turnStatus?: "running" | "failed";
	turnType?: "llm" | "human" | "automatic";
}) {
	const h = requireHarness();
	const turnType = input.turnType ?? "llm";
	const process = h.ctx.deps.processes.create({
		processId: "abort_turn_http_test_process",
		selectedTurnId: "implement",
		lifecycleStatus: input.lifecycleStatus,
		stateJson: JSON.stringify(createEmptyStructuralProcessState()),
	});
	const workerOwned = turnType === "llm" || turnType === "automatic";
	const lease = workerOwned
		? h.ctx.deps.leases.create({
				instanceId: process.id,
				workerId: `worker_${input.turnRecordId}`,
				state: input.turnStatus === "failed" ? "exited" : "busy",
			})
		: undefined;
	const turnStartRecordId = workerOwned ? `tsr_${input.turnRecordId}` : null;
	if (lease && turnStartRecordId) {
		h.ctx.deps.turnStarts.create({
			id: turnStartRecordId,
			instanceId: process.id,
			turnId: "implement",
			turnType,
			proposedTurnRecordId: input.turnRecordId,
			startKind: "selected_turn",
			recoveryTurnRecordId: null,
			continuation: null,
			state: {
				kind: "accepted",
				start:
					turnType === "automatic"
						? { kind: "automatic" }
						: {
								kind: "llm",
								model: {
									profileId: "fixture-profile",
									providerId: "fixture-provider",
									modelId: "fixture-model",
									thinkingLevel: "off",
								},
								providerOptions: {},
								providerWorkerConfig: null,
								piResourceSnapshotDigest: "fixture-resource-digest",
								workerRuntimeProfileId: "local",
								piSettings: {},
							},
				turnRecordId: input.turnRecordId,
				acceptedWorkerLeaseId: lease.id,
			},
		});
	}
	h.ctx.deps.turnRecords.create({
		id: input.turnRecordId,
		instanceId: process.id,
		turnId: "implement",
		turnType,
		status: input.turnStatus ?? "running",
		attemptNumber: 1,
		...(turnStartRecordId ? { turnStartRecordId } : {}),
		...(lease ? { acceptedWorkerLeaseId: lease.id } : {}),
		pathType: "primary",
		forkPiEntryId: "primary-leaf",
		startedAt: "2026-04-25T10:00:01.500Z",
	});
	if (workerOwned && turnStartRecordId && input.lifecycleStatus !== "completed") {
		h.ctx.deps.processes.update(process.id, {
			currentExecution: { kind: "worker_start", id: turnStartRecordId },
		});
	}
	return process;
}

function postAbortTurn(instanceId: string) {
	return requireHarness().ctx.app.inject({
		method: "POST",
		url: `/api/processes/${instanceId}/abort-turn`,
	});
}

describe("POST /api/processes/:instanceId/abort-turn", () => {
	it("dispatches a turn abort to the supervisor for an active running LLM turn with an attached worker", async () => {
		const h = requireHarness();
		const { process, turnRecordId, workerHandle } = await seedPreparedRunningLlmProcess();
		vi.spyOn(h.ctx.supervisor, "getWorker").mockReturnValue(workerHandle);
		const abortSpy = vi.spyOn(h.ctx.supervisor, "abortTurn").mockImplementation(() => {});

		const response = await postAbortTurn(process.id);

		expect(response.statusCode, response.body).toBe(200);
		expect(abortSpy).toHaveBeenCalledWith(process.id, "operator");
		const abortEvent = h.ctx.deps.events
			.listByInstance(process.id, 10)
			.find((event) => event.eventType === "turn_abort_requested");
		expect(abortEvent?.data.actor).toMatchObject({ id: "admin" });
		expect(abortEvent?.data.turnRecordId).toBe(turnRecordId);
	});

	it("returns 404 for an unknown process", async () => {
		const response = await postAbortTurn("agt_does_not_exist");
		expect(response.statusCode).toBe(404);
	});

	it("rejects when the process is not active", async () => {
		const h = requireHarness();
		const process = seedProcess({
			turnRecordId: "trn_abort_error",
			lifecycleStatus: "error",
			turnStatus: "failed",
		});
		const abortSpy = vi.spyOn(h.ctx.supervisor, "abortTurn").mockImplementation(() => {});

		const response = await postAbortTurn(process.id);

		expect(response.statusCode).toBe(400);
		expect(abortSpy).not.toHaveBeenCalled();
	});

	it("rejects when there is no running LLM turn", async () => {
		const h = requireHarness();
		const process = seedProcess({
			turnRecordId: "trn_abort_waiting",
			lifecycleStatus: "active",
			turnStatus: "running",
			turnType: "human",
		});
		const abortSpy = vi.spyOn(h.ctx.supervisor, "abortTurn").mockImplementation(() => {});

		const response = await postAbortTurn(process.id);

		expect(response.statusCode).toBe(400);
		expect(abortSpy).not.toHaveBeenCalled();
	});

	it("rejects running automatic turns because they do not observe the Pi abort signal", async () => {
		const h = requireHarness();
		const process = seedProcess({
			turnRecordId: "trn_abort_automatic",
			lifecycleStatus: "active",
			turnStatus: "running",
			turnType: "automatic",
		});
		const abortSpy = vi.spyOn(h.ctx.supervisor, "abortTurn").mockImplementation(() => {});

		const response = await postAbortTurn(process.id);

		expect(response.statusCode).toBe(400);
		expect(abortSpy).not.toHaveBeenCalled();
	});

	it("rejects when the running LLM turn has no attached worker", async () => {
		const h = requireHarness();
		const process = seedProcess({
			turnRecordId: "trn_abort_no_worker",
			lifecycleStatus: "active",
			turnStatus: "running",
		});
		vi.spyOn(h.ctx.supervisor, "getWorker").mockReturnValue(undefined);
		const abortSpy = vi.spyOn(h.ctx.supervisor, "abortTurn").mockImplementation(() => {});

		const response = await postAbortTurn(process.id);

		expect(response.statusCode).toBe(409);
		expect(abortSpy).not.toHaveBeenCalled();
	});
});

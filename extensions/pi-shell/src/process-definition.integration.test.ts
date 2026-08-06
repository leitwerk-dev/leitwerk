import { createProcessEngine } from "@leitwerk-dev/server";
import {
	buildProcessActionRegistry,
	createProcessOperationCoordinator,
	prepareSuccessfulLlmTurnStarts as createSuccessfulLlmTurnStarts,
	createTestDeps,
} from "@leitwerk-dev/server/testing";
import { describe, expect, it } from "vitest";
import { piShellProcess } from "./process-definition.js";
import { type PiShellParams, piShellActionIds, piShellProcessId, piShellTurnIds } from "./state.js";

const prepareSuccessfulLlmTurnStarts = createSuccessfulLlmTurnStarts();

function createSupervisorDouble() {
	const spawnCalls: string[] = [];
	return {
		spawnCalls,
		supervisor: {
			async spawnWorker(instanceId: string) {
				spawnCalls.push(instanceId);
				return { instanceId, workerId: `worker-${instanceId}`, send() {}, kill() {} };
			},
			async stopWorker() {},
			abortTurn() {},
			deliverInputs() {},
			getWorker() {
				return undefined;
			},
			isAdoptionPending() {
				return false;
			},
			async adoptRegisteredWorkers() {},
			async detachAll() {},
			async shutdownAll() {},
		},
	};
}

async function waitFor(assertion: () => boolean) {
	for (let i = 0; i < 100; i += 1) {
		if (assertion()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for assertion");
}

function createEngineHarness() {
	const deps = createTestDeps();
	const processGraphs = new Map([[piShellProcess.id, piShellProcess]]);
	const actionRegistry = buildProcessActionRegistry({ processes: processGraphs });
	const { supervisor, spawnCalls } = createSupervisorDouble();
	const commands = createProcessEngine({
		...deps,
		processOperations: createProcessOperationCoordinator(),
		processGraphs,
		getProcessActionRegistry: () => actionRegistry,
		getSupervisor: () => supervisor,
		prepareTurnStarts: prepareSuccessfulLlmTurnStarts,
	});
	return { deps, commands, spawnCalls };
}

describe("piShellProcess integration", () => {
	it("routes an initial prompt through the entry turn and requests an LLM worker turn", async () => {
		const { deps, commands, spawnCalls } = createEngineHarness();
		const params: PiShellParams = {
			workingDirectory: "/tmp/primary",
			initialPrompt: "fix npm run dev",
		};
		const process = deps.processes.create({
			processId: piShellProcessId,
			selectedTurnId: null,
			lifecycleStatus: "discovered",
			paramsJson: JSON.stringify(params),
			stateJson: JSON.stringify(piShellProcess.initialState(params)),
		});

		const result = await commands.startProcess(process.id, piShellTurnIds.open);

		expect(result.ok).toBe(true);
		await waitFor(
			() => deps.processes.getById(process.id)?.selectedTurnId === piShellTurnIds.runPrompt,
		);
		expect(spawnCalls).toEqual([process.id]);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: piShellTurnIds.runPrompt,
			lifecycleStatus: "active",
		});
	});

	it("opens the console without a worker when no initial prompt is pending", async () => {
		const { deps, commands, spawnCalls } = createEngineHarness();
		const params: PiShellParams = { workingDirectory: "/tmp/primary", initialPrompt: null };
		const process = deps.processes.create({
			processId: piShellProcessId,
			selectedTurnId: null,
			lifecycleStatus: "discovered",
			paramsJson: JSON.stringify(params),
			stateJson: JSON.stringify(piShellProcess.initialState(params)),
		});

		const result = await commands.startProcess(process.id, piShellTurnIds.open);

		expect(result.ok).toBe(true);
		await waitFor(
			() => deps.processes.getById(process.id)?.selectedTurnId === piShellTurnIds.console,
		);
		expect(spawnCalls).toEqual([]);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: piShellTurnIds.console,
			lifecycleStatus: "waiting",
		});
	});

	it("queues a prompt through a human action and requests an LLM worker turn", async () => {
		const { deps, commands, spawnCalls } = createEngineHarness();
		const params: PiShellParams = { workingDirectory: "/tmp/primary", initialPrompt: null };
		const process = deps.processes.create({
			processId: piShellProcessId,
			selectedTurnId: piShellTurnIds.console,
			lifecycleStatus: "waiting",
			paramsJson: JSON.stringify(params),
			stateJson: JSON.stringify(piShellProcess.initialState(params)),
		});

		const result = await commands.executeProcessAction(process.id, piShellActionIds.sendPrompt, {
			prompt: "fix npm run dev",
		});

		expect(result.ok).toBe(true);
		expect(spawnCalls).toEqual([process.id]);
		const updated = deps.processes.getById(process.id);
		expect(updated).toMatchObject({
			selectedTurnId: piShellTurnIds.runPrompt,
			lifecycleStatus: "active",
		});
		expect(JSON.parse(updated?.stateJson ?? "{}")).toMatchObject({
			workingDirectory: "/tmp/primary",
			pendingPrompt: "fix npm run dev",
		});
	});
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildProcessLaunchersForTest,
	createTestProcessInstance,
} from "@leitwerk-dev/extension-runtime/testing";
import type { ServerExtensionAPI } from "@leitwerk-dev/process-sdk";
import { createProcessEngine } from "@leitwerk-dev/server";
import {
	buildProcessActionRegistry,
	createProcessOperationCoordinator,
	createTestDeps,
} from "@leitwerk-dev/server/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import localShellExtension from "./index.js";
import {
	abortActiveLocalShellCommand,
	abortAllActiveLocalShellCommands,
	hasActiveLocalShellCommand,
	localShellProcess,
} from "./process-definition.js";
import {
	createPendingCommand,
	DEFAULT_COMMAND_TIMEOUT_MS,
	type LocalShellParams,
	type LocalShellState,
	localShellActionIds,
	localShellProcessId,
	localShellTurnIds,
} from "./state.js";

// Spawning real shell commands can be slow under the full parallel suite; raise
// the timeout so the longer waitFor budget does not exceed the test timeout.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "local-shell-process-integration-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await abortAllActiveLocalShellCommands();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function emptyState(overrides: Partial<LocalShellState> = {}): LocalShellState {
	return {
		pendingCommand: null,
		defaultCwd: null,
		nextSequence: 1,
		...overrides,
	};
}

const defaultParams: LocalShellParams = {
	defaultCwd: null,
	initialCommand: null,
	timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
};

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitFor(assertion: () => boolean) {
	for (let i = 0; i < 1_000; i += 1) {
		if (assertion()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for assertion");
}

async function nextMacrotask(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

function createEngineHarness() {
	const deps = createTestDeps();
	const processGraphs = new Map([[localShellProcess.id, localShellProcess]]);
	const actionRegistry = buildProcessActionRegistry({ processes: processGraphs });
	const commands = createProcessEngine({
		...deps,
		processOperations: createProcessOperationCoordinator(),
		processGraphs,
		getProcessActionRegistry: () => actionRegistry,
		getSupervisor: () => undefined,
	});
	return { deps, commands };
}

function executeTurn() {
	const turn = localShellProcess.turns.get(localShellTurnIds.execute)?.definition;
	expect(turn?.kind).toBe("server_automatic");
	if (turn?.kind !== "server_automatic") {
		throw new Error("execute_command turn is not server_automatic");
	}
	return turn;
}

describe("localShellProcess server-automatic command integration", () => {
	it("executes commands through the process engine without blocking the action response", async () => {
		const { deps, commands } = createEngineHarness();
		const cwd = tempDir();
		const doneFile = path.join(cwd, "release-command");
		const process = deps.processes.create({
			processId: localShellProcessId,
			selectedTurnId: localShellTurnIds.console,
			lifecycleStatus: "waiting",
			paramsJson: JSON.stringify(defaultParams),
			stateJson: JSON.stringify(emptyState({ defaultCwd: cwd })),
		});
		let actionResult: { settled: false } | { settled: true; value: { ok: boolean } } = {
			settled: false,
		};
		const actionPromise = commands
			.executeProcessAction(process.id, localShellActionIds.runCommand, {
				command: `while [ ! -f ${shellQuote(doneFile)} ]; do sleep 0.05; done; printf engine-output`,
				timeoutSeconds: 5,
			})
			.then((value) => {
				actionResult = { settled: true, value };
				return value;
			});
		await waitFor(() => hasActiveLocalShellCommand(process.id));
		await nextMacrotask();
		if (!actionResult.settled) {
			writeFileSync(doneFile, "done", "utf8");
			await actionPromise;
			throw new Error("run-command action waited for command completion");
		}
		expect(actionResult.value.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: localShellTurnIds.execute,
			lifecycleStatus: "active",
		});

		writeFileSync(doneFile, "done", "utf8");
		await waitFor(
			() => deps.processes.getById(process.id)?.selectedTurnId === localShellTurnIds.console,
		);
		expect(deps.processes.getById(process.id)).toMatchObject({ lifecycleStatus: "waiting" });
		expect(
			deps.turnRecords
				.listByInstance(process.id)
				.some(
					(record) =>
						record.turnId === localShellTurnIds.execute &&
						record.status === "succeeded" &&
						record.turnResultMarkdown?.includes("engine-output"),
				),
		).toBe(true);
	});

	it("runs an initial command from the UI launcher start turn", async () => {
		const { deps, commands } = createEngineHarness();
		const cwd = tempDir();
		const launcher = buildProcessLaunchersForTest(localShellProcess)?.launchers.get(
			"local_shell_process.local_shell_ui",
		);
		const resolved = launcher?.ui?.resolveLaunchConfig(
			{ defaultCwd: cwd, initialCommand: "printf initial-output", timeoutSeconds: 5 },
			{},
		);
		expect(resolved?.ok).toBe(true);
		if (!resolved?.ok) {
			throw new Error("expected local shell launcher to resolve initial command config");
		}
		const params = resolved.launchConfig.params as LocalShellParams;
		const process = deps.processes.create({
			processId: localShellProcessId,
			selectedTurnId: null,
			lifecycleStatus: "discovered",
			paramsJson: JSON.stringify(params),
			stateJson: JSON.stringify(localShellProcess.initialState(params)),
		});

		const started = await commands.startProcess(
			process.id,
			resolved.launchConfig.startTurnId ?? localShellTurnIds.console,
		);

		expect(started.ok).toBe(true);
		await waitFor(
			() => deps.processes.getById(process.id)?.selectedTurnId === localShellTurnIds.console,
		);
		expect(deps.processes.getById(process.id)).toMatchObject({ lifecycleStatus: "waiting" });
		expect(deps.turnRecords.listByInstance(process.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					turnId: localShellTurnIds.execute,
					status: "succeeded",
					turnResultMarkdown: expect.stringContaining("initial-output"),
				}),
			]),
		);
	});

	it("does not replay an interrupted running command during server-automatic reconciliation", async () => {
		const { deps, commands } = createEngineHarness();
		const cwd = tempDir();
		const marker = path.join(cwd, "should-not-exist");
		const pendingCommand = createPendingCommand({
			sequence: 1,
			command: `touch ${shellQuote(marker)}`,
			cwd,
			timeoutMs: 5_000,
		});
		const process = deps.processes.create({
			processId: localShellProcessId,
			selectedTurnId: localShellTurnIds.execute,
			lifecycleStatus: "active",
			paramsJson: JSON.stringify(defaultParams),
			stateJson: JSON.stringify(emptyState({ pendingCommand, nextSequence: 2, defaultCwd: cwd })),
		});
		deps.turnRecords.create({
			id: "trn_interrupted_local_shell",
			instanceId: process.id,
			turnId: localShellTurnIds.execute,
			turnType: "server_automatic",
			status: "running",
			pathType: "primary",
		});
		deps.processes.update(process.id, {
			currentExecution: { kind: "server_turn", id: "trn_interrupted_local_shell" },
		});

		await commands.drainServerAutomaticTurns(process.id);

		expect(existsSync(marker)).toBe(false);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: localShellTurnIds.execute,
			lifecycleStatus: "error",
			currentExecution: { kind: "server_turn", id: "trn_interrupted_local_shell" },
		});
		expect(deps.turnRecords.getById("trn_interrupted_local_shell")).toMatchObject({
			status: "failed",
			errorClass: "infrastructure",
		});
	});

	it("fails fast when execute_command has no pending command", async () => {
		await expect(
			executeTurn().run({
				process: createTestProcessInstance({ processId: localShellProcessId }),
				projects: [],
				params: defaultParams,
				state: emptyState(),
				readSemanticTurnResultMarkdown: () => null,
				readProductTurnResultMarkdown: () => null,
			}),
		).rejects.toThrow(/No pending command/);
	});

	it("executes a real command and returns durable turn markdown plus next state", async () => {
		const cwd = tempDir();
		const pendingCommand = createPendingCommand({
			sequence: 1,
			command: "printf shell-output",
			cwd,
			timeoutMs: 5_000,
		});

		const result = await executeTurn().run({
			process: createTestProcessInstance({ processId: localShellProcessId }),
			projects: [],
			params: defaultParams,
			state: emptyState({ pendingCommand, nextSequence: 2 }),
			readSemanticTurnResultMarkdown: () => null,
			readProductTurnResultMarkdown: () => null,
		});

		expect(result.outcome).toBe("command_finished");
		expect(result.params).toEqual(expect.objectContaining({ sequence: 1, exitCode: 0 }));
		expect(result.markdown).toContain("shell-output");
		expect(result.state).toEqual(
			expect.objectContaining({ pendingCommand: null, defaultCwd: cwd }),
		);
	});

	it("aborts an active command through the process cleanup hook when the process is aborted", async () => {
		const { deps, commands } = createEngineHarness();
		const cwd = tempDir();
		const process = deps.processes.create({
			processId: localShellProcessId,
			selectedTurnId: localShellTurnIds.console,
			lifecycleStatus: "waiting",
			paramsJson: JSON.stringify(defaultParams),
			stateJson: JSON.stringify(emptyState({ defaultCwd: cwd })),
		});

		const actionResult = await commands.executeProcessAction(
			process.id,
			localShellActionIds.runCommand,
			{ command: "sleep 5", timeoutSeconds: 5 },
		);
		expect(actionResult.ok).toBe(true);
		await waitFor(() => hasActiveLocalShellCommand(process.id));

		const abortResult = await commands.abortProcess(process.id);

		expect(abortResult.ok).toBe(true);
		expect(hasActiveLocalShellCommand(process.id)).toBe(false);
		const abortedProcess = deps.processes.getById(process.id);
		expect(abortedProcess).toMatchObject({
			selectedTurnId: null,
			lifecycleStatus: "aborted",
			currentExecution: null,
		});
		expect(JSON.parse(abortedProcess?.stateJson ?? "{}")).toMatchObject({
			pendingCommand: null,
		});
		expect(deps.turnRecords.listByInstance(process.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ turnId: localShellTurnIds.execute, status: "superseded" }),
			]),
		);
	});

	it("registers a server stop hook that aborts active commands", async () => {
		const stopHooks: Array<() => void | Promise<void>> = [];
		await localShellExtension.setupServer?.(
			{
				events: {} as ServerExtensionAPI["events"],
				onStart() {},
				onStop(handler) {
					stopHooks.push(handler);
				},
				provide() {},
				get() {
					return undefined;
				},
				require() {
					throw new Error("Unexpected capability request");
				},
			},
			undefined,
		);
		const stop = stopHooks[0];
		expect(stop).toBeDefined();
		if (!stop) {
			return;
		}
		const cwd = tempDir();
		const instanceId = "proc_local_shell_stop_hook_test";
		const pendingCommand = createPendingCommand({
			sequence: 1,
			command: "sleep 5",
			cwd,
			timeoutMs: 5_000,
		});
		const promise = executeTurn().run({
			process: createTestProcessInstance({ id: instanceId, processId: localShellProcessId }),
			projects: [],
			params: defaultParams,
			state: emptyState({ pendingCommand, nextSequence: 2 }),
			readSemanticTurnResultMarkdown: () => null,
			readProductTurnResultMarkdown: () => null,
		});
		await waitFor(() => hasActiveLocalShellCommand(instanceId));

		await stop();
		const result = await promise;

		expect(result.outcome).toBe("runner_error");
		expect(hasActiveLocalShellCommand(instanceId)).toBe(false);
	});

	it("aborts an active command through the command registry helper", async () => {
		const cwd = tempDir();
		const instanceId = "proc_local_shell_abort_test";
		const pendingCommand = createPendingCommand({
			sequence: 1,
			command: "sleep 5",
			cwd,
			timeoutMs: 5_000,
		});
		const promise = executeTurn().run({
			process: createTestProcessInstance({ id: instanceId, processId: localShellProcessId }),
			projects: [],
			params: defaultParams,
			state: emptyState({ pendingCommand, nextSequence: 2 }),
			readSemanticTurnResultMarkdown: () => null,
			readProductTurnResultMarkdown: () => null,
		});

		await waitFor(() => hasActiveLocalShellCommand(instanceId));
		expect(abortActiveLocalShellCommand(instanceId)).toBe(true);
		const result = await promise;

		expect(result.outcome).toBe("runner_error");
		expect(result.params).toEqual(expect.objectContaining({ sequence: 1 }));
		expect(result.state?.pendingCommand).toBeNull();
	});
});

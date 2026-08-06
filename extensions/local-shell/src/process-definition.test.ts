import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildProcessLaunchersForTest,
	buildServerProcessForTest,
	createTestProcessInstance,
	createTestServerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { getProcessGraph } from "@leitwerk-dev/process-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { buildCommandResultMarkdown, localShellProcess } from "./process-definition.js";
import {
	createPendingCommand,
	DEFAULT_COMMAND_TIMEOUT_MS,
	type LocalShellParams,
	type LocalShellState,
	localShellActionIds,
	localShellProcessId,
	localShellTurnIds,
	MAX_COMMAND_LENGTH_CHARS,
} from "./state.js";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "local-shell-process-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
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

describe("localShellProcess", () => {
	it("declares a no-LLM command loop that returns to the console after every outcome", () => {
		const graph = getProcessGraph(
			new Map([[localShellProcess.id, localShellProcess]]),
			localShellProcess.id,
		);

		expect(graph.turns.get(localShellTurnIds.open)?.turnType).toBe("server_automatic");
		expect(graph.turns.get(localShellTurnIds.console)?.turnType).toBe("human");
		expect(graph.turns.get(localShellTurnIds.console)?.reviewSubject).toBeUndefined();
		expect(graph.turns.get(localShellTurnIds.execute)?.turnType).toBe("server_automatic");
		expect(localShellProcess.turns.get(localShellTurnIds.console)?.definition).toMatchObject({
			operatorAttention: "passive",
		});
		expect(localShellProcess.turns.get(localShellTurnIds.execute)?.definition).toMatchObject({
			restartBehavior: "fail_running",
		});
		expect(
			[...localShellProcess.turns.values()].some(({ definition }) => definition.kind === "llm"),
		).toBe(false);
		expect(graph.turns.get(localShellTurnIds.open)?.transitions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					outcome: "opened",
					nextTurnId: localShellTurnIds.console,
				}),
				expect.objectContaining({
					outcome: "run_initial",
					nextTurnId: localShellTurnIds.execute,
				}),
			]),
		);
		expect(graph.turns.get(localShellTurnIds.console)?.transitions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					trigger: localShellActionIds.runCommand,
					nextTurnId: localShellTurnIds.execute,
				}),
				expect.objectContaining({
					trigger: localShellActionIds.closeShell,
					lifecycleStatus: "completed",
				}),
			]),
		);
		expect(graph.turns.get(localShellTurnIds.execute)?.transitions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					outcome: "command_finished",
					nextTurnId: localShellTurnIds.console,
				}),
				expect.objectContaining({
					outcome: "command_timed_out",
					nextTurnId: localShellTurnIds.console,
				}),
				expect.objectContaining({ outcome: "runner_error", nextTurnId: localShellTurnIds.console }),
			]),
		);
	});

	it("resolves launch config for waiting shells and initial commands", () => {
		const cwd = tempDir();
		const launchers = buildProcessLaunchersForTest(localShellProcess);
		const launcher = launchers?.launchers.get("local_shell_process.local_shell_ui");
		expect(launcher?.ui).toBeDefined();
		if (!launcher?.ui) {
			return;
		}

		const waiting = launcher.ui.resolveLaunchConfig({ defaultCwd: cwd, initialCommand: "" }, {});
		expect(waiting).toEqual({
			ok: true,
			launchConfig: expect.objectContaining({
				processId: localShellProcessId,
				startTurnId: localShellTurnIds.open,
				params: expect.objectContaining({ defaultCwd: cwd, initialCommand: null }),
				title: expect.any(String),
			}),
		});

		const initial = launcher.ui.resolveLaunchConfig(
			{ defaultCwd: cwd, initialCommand: "  echo hello  ", timeoutSeconds: 1 },
			{},
		);
		expect(initial).toEqual({
			ok: true,
			launchConfig: expect.objectContaining({
				startTurnId: localShellTurnIds.open,
				params: expect.objectContaining({
					defaultCwd: cwd,
					initialCommand: "echo hello",
					timeoutMs: 1000,
				}),
				title: expect.any(String),
			}),
		});
	});

	it("rejects launcher working directories that are not available", () => {
		const launchers = buildProcessLaunchersForTest(localShellProcess);
		const launcher = launchers?.launchers.get("local_shell_process.local_shell_ui");
		expect(launcher?.ui).toBeDefined();
		if (!launcher?.ui) {
			return;
		}

		const resolved = launcher.ui.resolveLaunchConfig(
			{ defaultCwd: path.join(tempDir(), "missing") },
			{},
		);

		expect(resolved).toEqual({
			ok: false,
			errors: [expect.objectContaining({ fieldId: "defaultCwd", code: "invalid_cwd" })],
		});
	});

	it("rejects oversized launcher commands before storing them in params", () => {
		const launchers = buildProcessLaunchersForTest(localShellProcess);
		const launcher = launchers?.launchers.get("local_shell_process.local_shell_ui");
		expect(launcher?.ui).toBeDefined();
		if (!launcher?.ui) {
			return;
		}

		const resolved = launcher.ui.resolveLaunchConfig(
			{ initialCommand: "x".repeat(MAX_COMMAND_LENGTH_CHARS + 1) },
			{},
		);

		expect(resolved).toEqual({
			ok: false,
			errors: [expect.objectContaining({ fieldId: "initialCommand", code: "invalid_command" })],
		});
	});

	it("plans the run-command action by storing a pending command and selecting execute_command", async () => {
		const cwd = tempDir();
		const action = buildServerProcessForTest(localShellProcess)?.actions.get(
			localShellActionIds.runCommand,
		);
		expect(action?.plan).toBeDefined();
		if (!action?.plan) {
			return;
		}
		const transitions: Array<Record<string, unknown>> = [];

		await action.plan(
			{ command: "  pwd  ", cwd, timeoutSeconds: 2 },
			createTestServerProcessContext({
				process: createTestProcessInstance({
					processId: localShellProcessId,
					selectedTurnId: localShellTurnIds.console,
					lifecycleStatus: "waiting",
				}),
				params: defaultParams,
				state: emptyState({ nextSequence: 4 }),
				transition: async (next) => {
					transitions.push(next as Record<string, unknown>);
				},
			}),
		);

		expect(transitions).toHaveLength(1);
		expect(transitions[0]).toEqual(
			expect.objectContaining({
				turnId: localShellTurnIds.execute,
				trigger: localShellActionIds.runCommand,
			}),
		);
		const nextState = transitions[0]?.state as LocalShellState;
		expect(nextState.pendingCommand).toEqual(
			expect.objectContaining({ command: "pwd", cwd, sequence: 4, timeoutMs: 2000 }),
		);
		expect(nextState.nextSequence).toBe(5);
	});

	it("rejects oversized action commands before storing pending command state", async () => {
		const action = buildServerProcessForTest(localShellProcess)?.actions.get(
			localShellActionIds.runCommand,
		);
		expect(action?.plan).toBeDefined();
		if (!action?.plan) {
			return;
		}

		await expect(
			action.plan(
				{ command: "x".repeat(MAX_COMMAND_LENGTH_CHARS + 1) },
				createTestServerProcessContext({
					process: createTestProcessInstance({
						processId: localShellProcessId,
						selectedTurnId: localShellTurnIds.console,
						lifecycleStatus: "waiting",
					}),
					params: defaultParams,
					state: emptyState(),
				}),
			),
		).rejects.toThrow(/maximum length/);
	});

	it("resolves relative action working directories against the current shell default", async () => {
		const root = tempDir();
		const child = path.join(root, "child");
		mkdirSync(child);
		const action = buildServerProcessForTest(localShellProcess)?.actions.get(
			localShellActionIds.runCommand,
		);
		expect(action?.plan).toBeDefined();
		if (!action?.plan) {
			return;
		}
		const transitions: Array<Record<string, unknown>> = [];

		await action.plan(
			{ command: "pwd", cwd: "child" },
			createTestServerProcessContext({
				process: createTestProcessInstance({
					processId: localShellProcessId,
					selectedTurnId: localShellTurnIds.console,
					lifecycleStatus: "waiting",
				}),
				params: defaultParams,
				state: emptyState({ defaultCwd: root }),
				transition: async (next) => {
					transitions.push(next as Record<string, unknown>);
				},
			}),
		);

		const nextState = transitions[0]?.state as LocalShellState;
		expect(nextState.pendingCommand?.cwd).toBe(child);
		expect(nextState.defaultCwd).toBe(child);
	});

	it("uses the launcher default timeout for later commands when no action timeout is supplied", async () => {
		const action = buildServerProcessForTest(localShellProcess)?.actions.get(
			localShellActionIds.runCommand,
		);
		expect(action?.plan).toBeDefined();
		if (!action?.plan) {
			return;
		}
		const transitions: Array<Record<string, unknown>> = [];

		await action.plan(
			{ command: "pwd" },
			createTestServerProcessContext({
				process: createTestProcessInstance({
					processId: localShellProcessId,
					selectedTurnId: localShellTurnIds.console,
					lifecycleStatus: "waiting",
				}),
				params: { ...defaultParams, timeoutMs: 7_500 },
				state: emptyState(),
				transition: async (next) => {
					transitions.push(next as Record<string, unknown>);
				},
			}),
		);

		const nextState = transitions[0]?.state as LocalShellState;
		expect(nextState.pendingCommand?.timeoutMs).toBe(7_500);
	});

	it("builds markdown with both streams without relying on exact prose", () => {
		const markdown = buildCommandResultMarkdown({
			command: createPendingCommand({
				sequence: 1,
				command: "echo hi",
				cwd: null,
				timeoutMs: 1000,
			}),
			result: {
				outcome: "finished",
				cwd: tempDir(),
				exitCode: 0,
				signal: null,
				durationMs: 12,
				stdout: "hi\n",
				stderr: "warn\n",
				stdoutTruncated: false,
				stderrTruncated: false,
				errorMessage: null,
				timedOut: false,
			},
		});

		expect(markdown).toContain("echo hi");
		expect(markdown).toContain("hi");
		expect(markdown).toContain("warn");
	});

	it("renders command metadata as inline code without raw control characters", () => {
		const cwd = `${tempDir()}/weird\`dir\nname`;
		const errorMessage = "bad `thing`\nnext line";
		const markdown = buildCommandResultMarkdown({
			command: createPendingCommand({
				sequence: 1,
				command: "echo hi",
				cwd: null,
				timeoutMs: 1000,
			}),
			result: {
				outcome: "runner_error",
				cwd,
				exitCode: null,
				signal: null,
				durationMs: 12,
				stdout: "",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				errorMessage,
				timedOut: false,
			},
		});

		expect(markdown).not.toContain(cwd);
		expect(markdown).not.toContain(errorMessage);
		expect(markdown).toContain("weird`dir\\nname");
		expect(markdown).toContain("bad `thing`\\nnext line");
		expect(markdown).toMatch(/- cwd: `+/);
		expect(markdown).toMatch(/- runner error: `+/);
	});
});

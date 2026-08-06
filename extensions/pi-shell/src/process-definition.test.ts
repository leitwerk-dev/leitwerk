import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildProcessLaunchersForTest,
	createTestProcessInstance,
} from "@leitwerk-dev/extension-runtime/testing";
import { createTemplateContext, resolveProcessPiConfig } from "@leitwerk-dev/process-sdk/pi-config";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiShellPrompt, piShellProcess } from "./process-definition.js";
import { piShellActionIds, piShellProcessId, piShellTurnIds } from "./state.js";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-shell-process-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("piShellProcess", () => {
	it("includes the requested working directory and operator input", () => {
		const prompt = buildPiShellPrompt({
			workingDirectory: "/tmp/SENTINEL_WORKING_DIRECTORY",
			prompt: "SENTINEL_OPERATOR_INPUT",
		});
		expect(prompt).toContain("/tmp/SENTINEL_WORKING_DIRECTORY");
		expect(prompt).toContain("SENTINEL_OPERATOR_INPUT");
	});

	it("resolves the requested directory as the Pi session working directory", () => {
		const resolved = resolveProcessPiConfig({
			processId: piShellProcessId,
			processPiConfig: piShellProcess.piConfig,
			templateContext: createTemplateContext({
				params: { workingDirectory: "/tmp/primary" },
			}),
		});

		expect(resolved.sessionCwd).toBe("/tmp/primary");
	});

	it("declares only the standard read/bash/edit/write tools and assistant-output result capture", () => {
		const runTurn = piShellProcess.turns.get(piShellTurnIds.runPrompt)?.definition;
		expect(runTurn?.kind).toBe("llm");
		if (runTurn?.kind !== "llm") {
			return;
		}
		expect(runTurn.availableTools).toEqual(["read", "bash", "edit", "write"]);
		expect(runTurn.outcomes).toEqual({});
		expect(runTurn.turnResultMarkdown).toEqual({ mode: "assistant_output", required: true });
		expect(() =>
			runTurn.prompt({
				process: createTestProcessInstance({
					processId: piShellProcessId,
					selectedTurnId: piShellTurnIds.runPrompt,
				}),
				projects: [],
				params: { workingDirectory: "/tmp/primary", initialPrompt: null },
				state: { workingDirectory: "/tmp/primary", pendingPrompt: null },
			}),
		).toThrow();
	});

	it("uses an entry turn so both empty and initial-prompt launches start through the state machine", () => {
		const workingDirectory = tempDir();
		const launcher = buildProcessLaunchersForTest(piShellProcess)?.launchers.get(
			"pi_shell_process.pi_shell_ui",
		);
		expect(launcher).toBeDefined();
		const waiting = launcher?.ui.resolveLaunchConfig({ workingDirectory }, {});
		expect(waiting?.ok).toBe(true);
		if (waiting?.ok) {
			expect(waiting.launchConfig).toMatchObject({
				processId: piShellProcessId,
				startTurnId: piShellTurnIds.open,
			});
		}
		const immediate = launcher?.ui.resolveLaunchConfig(
			{ workingDirectory, initialPrompt: "repair" },
			{},
		);
		expect(immediate?.ok).toBe(true);
		if (immediate?.ok) {
			expect(immediate.launchConfig).toMatchObject({
				processId: piShellProcessId,
				startTurnId: piShellTurnIds.open,
			});
			expect(immediate.launchConfig.params.initialPrompt).toBe("repair");
		}
	});

	it("routes the entry turn based on whether an initial prompt is pending", () => {
		const openTurn = piShellProcess.turns.get(piShellTurnIds.open)?.definition;
		expect(openTurn?.kind).toBe("server_automatic");
		if (openTurn?.kind !== "server_automatic") {
			return;
		}
		expect(openTurn.outcomes.opened?.to).toBe(piShellTurnIds.console);
		expect(openTurn.outcomes.run_initial?.to).toBe(piShellTurnIds.runPrompt);
	});

	it("rejects launcher working directories that do not exist or are not directories", () => {
		const existingDir = tempDir();
		const filePath = path.join(existingDir, "file.txt");
		writeFileSync(filePath, "not a directory", "utf8");
		const launcher = buildProcessLaunchersForTest(piShellProcess)?.launchers.get(
			"pi_shell_process.pi_shell_ui",
		);

		const missing = launcher?.ui.resolveLaunchConfig(
			{ workingDirectory: path.join(existingDir, "missing") },
			{},
		);
		const file = launcher?.ui.resolveLaunchConfig({ workingDirectory: filePath }, {});

		expect(missing?.ok).toBe(false);
		expect(file?.ok).toBe(false);
	});

	it("exposes send prompt and close actions on the console turn", () => {
		const consoleTurn = piShellProcess.turns.get(piShellTurnIds.console)?.definition;
		expect(consoleTurn?.kind).toBe("human");
		if (consoleTurn?.kind !== "human") {
			return;
		}
		expect(Object.keys(consoleTurn.actions).sort()).toEqual(
			[piShellActionIds.close, piShellActionIds.sendPrompt].sort(),
		);
	});
});

import { statSync } from "node:fs";

import {
	defineProcess,
	humanTurn,
	type LlmTurnDefinition,
	llmTurn,
	serverAutomaticTurn,
} from "@leitwerk-dev/process-sdk";
import {
	createInitialPiShellState,
	type PiShellParams,
	type PiShellState,
	piShellActionIds,
	piShellParamsCodec,
	piShellProcessId,
	piShellStateCodec,
	piShellTurnIds,
	stateWithPendingPiShellPrompt,
} from "./state.js";

const ASSISTANT_OUTPUT_TURN_RESULT = { mode: "assistant_output", required: true } as const;

export function buildPiShellPrompt(input: { workingDirectory: string; prompt: string }): string {
	return `You are running a trusted, non-sandboxed linear recovery Pi shell for a local operator.

Default target directory: ${input.workingDirectory}

Rules:
- This is not an OS or filesystem sandbox. Tools can access anything the worker process can access.
- Treat the default target directory as the intended focus of this session.
- The Pi session working directory is the default target directory, so relative tool paths and shell commands start there.
- Use only the built-in read, bash, edit, and write tools.
- Do not modify files outside the default target directory unless the operator explicitly asks.
- There are no outcome tools in this session. Your final assistant response is the durable result for this turn.

Operator prompt:

${input.prompt}`;
}

function runPromptTurn(): LlmTurnDefinition<"responded", PiShellParams, PiShellState> {
	return llmTurn<PiShellParams, PiShellState, "responded">({
		description: "Run one operator prompt in the linear Pi shell",
		availableTools: ["read", "bash", "edit", "write"],
		completionMode: "turn_end",
		branchType: "primary",
		context: "full",
		prompt(ctx) {
			const pendingPrompt = ctx.state.pendingPrompt;
			if (!pendingPrompt) {
				throw new Error("No pending Pi shell prompt");
			}
			return buildPiShellPrompt({
				workingDirectory: ctx.state.workingDirectory,
				prompt: pendingPrompt,
			});
		},
		outcomes: {},
		turnEnd: {
			outcome: "responded",
			params: {},
			to: piShellTurnIds.console,
			effect: ({ ctx }) => ({
				state: {
					...ctx.state,
					pendingPrompt: null,
				},
			}),
		},
		turnResultMarkdown: ASSISTANT_OUTPUT_TURN_RESULT,
	});
}

function workingDirectoryValidationError(workingDirectory: string): string | null {
	try {
		return statSync(workingDirectory).isDirectory()
			? null
			: "Working directory must be an existing directory.";
	} catch {
		return "Working directory must be an existing directory.";
	}
}

const openTurn = serverAutomaticTurn<PiShellParams, PiShellState, "opened" | "run_initial">({
	description: "Open the linear Pi shell session",
	run: ({ state }) => ({
		outcome: state.pendingPrompt ? "run_initial" : "opened",
		params: {},
	}),
	outcomes: {
		opened: {
			description: "The shell opened without an initial prompt",
			parameters: {},
			to: piShellTurnIds.console,
		},
		run_initial: {
			description: "The shell opened with an initial prompt",
			parameters: {},
			to: piShellTurnIds.runPrompt,
		},
	},
});

const consoleTurn = humanTurn<PiShellParams, PiShellState>({
	description: "Wait for the next operator prompt in the linear Pi shell",
	operatorAttention: "passive",
	actions: {
		[piShellActionIds.sendPrompt]: {
			label: "Send prompt",
			description: "Append one operator prompt to this linear Pi shell session.",
			acceptanceState: "neutral",
			form: {
				id: "pi_shell_prompt",
				title: "Send prompt",
				fields: [
					{
						id: "prompt",
						label: "Prompt",
						kind: "textarea",
						primaryPrompt: true,
						required: true,
						description: "Instruction for the next Pi shell turn.",
					},
				],
				submitLabel: "Send prompt",
			},
			preview: { kind: "fixed_turn", turnId: piShellTurnIds.runPrompt },
			to: piShellTurnIds.runPrompt,
			effect: ({ ctx, input }) => ({
				state: stateWithPendingPiShellPrompt({ state: ctx.state, prompt: input.prompt }),
			}),
		},
		[piShellActionIds.close]: {
			label: "Close session",
			description: "Complete this Pi shell process.",
			acceptanceState: "accepted",
			complete: true,
			preview: { kind: "terminal", lifecycleStatus: "completed" },
		},
	},
});

export const piShellProcess = defineProcess<PiShellParams, PiShellState>({
	id: piShellProcessId,
	displayName: "Pi Shell",
	entry: piShellTurnIds.open,
	paramsCodec: piShellParamsCodec,
	stateCodec: piShellStateCodec,
	initialState: createInitialPiShellState,
	piConfig: {
		sessionCwdTemplate: "{{{workingDirectory}}}",
	},
	turns: {
		[piShellTurnIds.open]: openTurn,
		[piShellTurnIds.console]: consoleTurn,
		[piShellTurnIds.runPrompt]: runPromptTurn(),
	},
	launchers(api) {
		api.launcher({
			id: "pi_shell_process.pi_shell_ui",
			label: "Pi Shell",
			description:
				"Open a trusted, non-sandboxed linear Pi session with read, bash, edit, and write tools focused on a local directory.",
			visibility: "ui",
			ui: {
				card: {
					title: "Pi Shell",
					description:
						"Use Pi directly for trusted recovery work. This is not a filesystem sandbox.",
				},
				launchConfigSchema: {
					id: "pi_shell_launch",
					title: "Pi Shell",
					fields: [
						{
							id: "workingDirectory",
							label: "Default target directory",
							kind: "text",
							required: true,
							description:
								"Existing directory that the trusted, non-sandboxed session should treat as its focus.",
						},
						{
							id: "initialPrompt",
							label: "Initial prompt",
							kind: "textarea",
							description: "Optional first prompt to run immediately after launch.",
						},
					],
					submitLabel: "Open Pi shell",
				},
				resolveDefaults() {
					return { workingDirectory: process.cwd() };
				},
				resolveLaunchConfig(input) {
					let params: PiShellParams;
					try {
						params = piShellParamsCodec.parse(input);
					} catch (error) {
						return {
							ok: false,
							errors: [
								{
									code: "invalid_prompt",
									fieldId: "initialPrompt",
									message: error instanceof Error ? error.message : String(error),
								},
							],
						};
					}
					if (typeof input.workingDirectory !== "string" || input.workingDirectory.trim() === "") {
						return {
							ok: false,
							errors: [
								{
									code: "working_directory_required",
									fieldId: "workingDirectory",
									message: "Working directory is required.",
								},
							],
						};
					}
					const workingDirectoryError = workingDirectoryValidationError(params.workingDirectory);
					if (workingDirectoryError) {
						return {
							ok: false,
							errors: [
								{
									code: "invalid_working_directory",
									fieldId: "workingDirectory",
									message: workingDirectoryError,
								},
							],
						};
					}
					return {
						ok: true,
						launchConfig: {
							processId: piShellProcessId,
							params,
							title: `Pi Shell: ${params.workingDirectory}`,
							startTurnId: piShellTurnIds.open,
						},
					};
				},
			},
		});
	},
});

import {
	defineProcess,
	humanTurn,
	type ProcessToolOutcomeSpec,
	type ServerAutomaticTurnRunResult,
	serverAutomaticTurn,
} from "@leitwerk-dev/process-sdk";
import { resolveCommandCwd, runShellCommand, type ShellCommandResult } from "./command-runner.js";
import {
	commandPreview,
	createInitialLocalShellState,
	createPendingCommand,
	DEFAULT_COMMAND_TIMEOUT_MS,
	type LocalShellParams,
	type LocalShellState,
	localShellActionIds,
	localShellParamsCodec,
	localShellProcessId,
	localShellStateCodec,
	localShellTurnIds,
	normalizeCommandInput,
	type PendingLocalShellCommand,
	timeoutSecondsToMs,
	trimToNull,
} from "./state.js";

interface ActiveLocalShellCommand {
	controller: AbortController;
	done: Promise<ShellCommandResult>;
}

const activeCommands = new Map<string, ActiveLocalShellCommand>();

export function hasActiveLocalShellCommand(instanceId: string): boolean {
	return activeCommands.has(instanceId);
}

export function abortActiveLocalShellCommand(instanceId: string): boolean {
	const active = activeCommands.get(instanceId);
	if (!active) {
		return false;
	}
	active.controller.abort();
	return true;
}

export async function abortActiveLocalShellCommandAndWait(instanceId: string): Promise<boolean> {
	const active = activeCommands.get(instanceId);
	if (!active) {
		return false;
	}
	active.controller.abort();
	try {
		await active.done;
	} catch {
		// Command execution failures are recorded by the active server-automatic turn.
		// Cleanup should still be allowed to commit the abort.
	}
	return true;
}

export async function abortAllActiveLocalShellCommands(): Promise<number> {
	const active = [...activeCommands.values()];
	for (const command of active) {
		command.controller.abort();
	}
	await Promise.allSettled(active.map((command) => command.done));
	return active.length;
}

async function runTrackedShellCommand(
	instanceId: string,
	command: PendingLocalShellCommand,
): Promise<ShellCommandResult> {
	const controller = new AbortController();
	const done = runShellCommand({
		command: command.command,
		cwd: command.cwd,
		timeoutMs: command.timeoutMs,
		trackingKey: instanceId,
		signal: controller.signal,
	});
	activeCommands.set(instanceId, { controller, done });
	try {
		return await done;
	} finally {
		if (activeCommands.get(instanceId)?.controller === controller) {
			activeCommands.delete(instanceId);
		}
	}
}

function nonEmptyStringParam(description: string) {
	return { type: "string" as const, description, required: true };
}

function numberParam(description: string, required = false) {
	return { type: "number" as const, description, ...(required ? { required: true } : {}) };
}

function optionalStringParam(description: string) {
	return { type: "string" as const, description };
}

function commandOutcome(
	description: string,
	parameters: ProcessToolOutcomeSpec<LocalShellParams, LocalShellState>["parameters"] = {},
): ProcessToolOutcomeSpec<LocalShellParams, LocalShellState> {
	return {
		description,
		parameters: {
			sequence: numberParam("Command sequence number", true),
			...parameters,
			durationMs: numberParam("Command duration in milliseconds", true),
		},
		to: localShellTurnIds.console,
	};
}

const commandFinishedOutcome = commandOutcome(
	"The shell command finished, regardless of exit code",
	{
		exitCode: numberParam("Process exit code when available"),
		signal: optionalStringParam("Termination signal when available"),
	},
);

const commandTimedOutOutcome = commandOutcome(
	"The shell command exceeded its timeout and was terminated",
	{ signal: optionalStringParam("Termination signal when available") },
);

const commandRunnerErrorOutcome = commandOutcome(
	"The command runner could not start or complete the command cleanly",
	{ message: nonEmptyStringParam("Runner error message") },
);

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) {
		return `${durationMs}ms`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function markdownFence(value: string, language = "text"): string {
	let fence = "```";
	while (value.includes(fence)) {
		fence += "`";
	}
	return `${fence}${language}\n${value}${value.endsWith("\n") ? "" : "\n"}${fence}`;
}

function escapeInlineCodeCharacter(character: string): string {
	switch (character) {
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
	}
}

function normalizeInlineCodeValue(value: string): string {
	let normalized = "";
	for (const character of value) {
		const code = character.charCodeAt(0);
		normalized += code < 32 || code === 127 ? escapeInlineCodeCharacter(character) : character;
	}
	return normalized;
}

function markdownInlineCode(value: string | number): string {
	const normalized = normalizeInlineCodeValue(String(value));
	const longestBacktickRun = Math.max(
		0,
		...[...normalized.matchAll(/`+/g)].map((match) => match[0]?.length ?? 0),
	);
	const fence = "`".repeat(longestBacktickRun + 1);
	const needsPadding =
		normalized.startsWith("`") ||
		normalized.endsWith("`") ||
		normalized.startsWith(" ") ||
		normalized.endsWith(" ");
	return needsPadding ? `${fence} ${normalized} ${fence}` : `${fence}${normalized}${fence}`;
}

function outputSection(title: string, output: string, truncated: boolean): string {
	if (!output) {
		return `### ${title}\n\n_No ${title.toLowerCase()}._`;
	}
	return [
		`### ${title}`,
		truncated ? "\n_Output was truncated; showing the retained tail._" : "",
		markdownFence(output),
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

export function buildCommandResultMarkdown(input: {
	command: PendingLocalShellCommand;
	result: ShellCommandResult;
}): string {
	const { command, result } = input;
	const exit = result.exitCode === null ? "n/a" : String(result.exitCode);
	const signal = result.signal ?? "n/a";
	const statusLine =
		result.outcome === "timed_out"
			? "Command timed out."
			: result.outcome === "runner_error"
				? "Command runner error."
				: result.exitCode === 0
					? "Command finished successfully."
					: "Command finished with a non-zero exit code.";
	const sections = [
		"## Shell command result",
		statusLine,
		markdownFence(command.command, "sh"),
		[
			`- sequence: ${markdownInlineCode(command.sequence)}`,
			`- cwd: ${markdownInlineCode(result.cwd)}`,
			`- outcome: ${markdownInlineCode(result.outcome)}`,
			`- exit code: ${markdownInlineCode(exit)}`,
			`- signal: ${markdownInlineCode(signal)}`,
			`- duration: ${markdownInlineCode(formatDuration(result.durationMs))}`,
			`- timeout: ${markdownInlineCode(formatDuration(command.timeoutMs))}`,
			...(result.errorMessage
				? [`- runner error: ${markdownInlineCode(result.errorMessage)}`]
				: []),
		].join("\n"),
		outputSection("stdout", result.stdout, result.stdoutTruncated),
		outputSection("stderr", result.stderr, result.stderrTruncated),
	];
	return sections.join("\n\n");
}

function resolveActionCwd(
	inputValue: Record<string, unknown>,
	state: LocalShellState,
): string | null {
	const cwdInput = trimToNull(inputValue.cwd);
	const candidate = cwdInput ?? state.defaultCwd;
	if (!candidate) {
		return null;
	}
	const resolved = cwdInput
		? resolveCommandCwd(cwdInput, state.defaultCwd ?? process.cwd())
		: resolveCommandCwd(candidate);
	if (!resolved.ok) {
		throw new Error(resolved.message);
	}
	return resolved.cwd;
}

function createStateWithPendingCommand(input: {
	state: LocalShellState;
	inputValue: Record<string, unknown>;
	defaultTimeoutMs: number;
}): LocalShellState {
	if (input.state.pendingCommand) {
		throw new Error("A command is already pending for this shell process");
	}
	const command = normalizeCommandInput(input.inputValue.command);
	if (!command) {
		throw new Error("Command is required");
	}
	const cwd = resolveActionCwd(input.inputValue, input.state);
	const timeoutMs = timeoutSecondsToMs(input.inputValue.timeoutSeconds, input.defaultTimeoutMs);
	const sequence = input.state.nextSequence;
	return {
		...input.state,
		defaultCwd: cwd ?? input.state.defaultCwd,
		pendingCommand: createPendingCommand({ sequence, command, cwd, timeoutMs }),
		nextSequence: sequence + 1,
	};
}

type LocalShellTurnOutcome = "command_finished" | "command_timed_out" | "runner_error";

function toOutcome(result: ShellCommandResult): LocalShellTurnOutcome {
	if (result.outcome === "timed_out") {
		return "command_timed_out";
	}
	if (result.outcome === "runner_error") {
		return "runner_error";
	}
	return "command_finished";
}

function paramsForResult(
	command: PendingLocalShellCommand,
	result: ShellCommandResult,
): Record<string, unknown> {
	return {
		sequence: command.sequence,
		...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
		...(result.signal ? { signal: result.signal } : {}),
		...(result.errorMessage ? { message: result.errorMessage } : {}),
		durationMs: result.durationMs,
	};
}

async function executePendingCommand(ctx: {
	process: { id: string };
	state: LocalShellState;
}): Promise<ServerAutomaticTurnRunResult<LocalShellTurnOutcome, LocalShellState>> {
	const command = ctx.state.pendingCommand;
	if (!command) {
		throw new Error("No pending command was available to execute");
	}
	const result = await runTrackedShellCommand(ctx.process.id, command);
	return {
		outcome: toOutcome(result),
		params: paramsForResult(command, result),
		markdown: buildCommandResultMarkdown({ command, result }),
		state: {
			...ctx.state,
			pendingCommand: null,
			defaultCwd: command.cwd ?? ctx.state.defaultCwd,
		},
	};
}

function validateLauncherInput(input: Record<string, unknown>) {
	const defaultCwd = trimToNull(input.defaultCwd);
	let initialCommand: string | null;
	try {
		initialCommand = normalizeCommandInput(input.initialCommand);
	} catch (error) {
		return {
			ok: false as const,
			errors: [
				{
					code: "invalid_command",
					fieldId: "initialCommand",
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
	const timeoutMs = timeoutSecondsToMs(input.timeoutSeconds, DEFAULT_COMMAND_TIMEOUT_MS);
	if (!defaultCwd) {
		return { ok: true as const, defaultCwd: null, initialCommand, timeoutMs };
	}
	const resolved = resolveCommandCwd(defaultCwd);
	if (!resolved.ok) {
		return {
			ok: false as const,
			errors: [{ code: "invalid_cwd", fieldId: "defaultCwd", message: resolved.message }],
		};
	}
	return { ok: true as const, defaultCwd: resolved.cwd, initialCommand, timeoutMs };
}

function launcherTitle(input: {
	defaultCwd: string | null;
	initialCommand: string | null;
}): string {
	if (input.initialCommand) {
		return `Shell: ${commandPreview(input.initialCommand, 48)}`;
	}
	if (input.defaultCwd) {
		return `Shell: ${input.defaultCwd}`;
	}
	return "Local Shell";
}

const openShellTurn = serverAutomaticTurn<
	LocalShellParams,
	LocalShellState,
	"opened" | "run_initial"
>({
	description: "Open local shell",
	outcomes: {
		opened: {
			description: "The shell opened without an initial command",
			parameters: {},
			to: localShellTurnIds.console,
		},
		run_initial: {
			description: "The shell opened with an initial command",
			parameters: {},
			to: localShellTurnIds.execute,
		},
	},
	run: ({ state }) => ({
		outcome: state.pendingCommand ? "run_initial" : "opened",
		params: {},
	}),
});

const commandConsoleTurn = humanTurn<LocalShellParams, LocalShellState>({
	description: "Local shell command console",
	operatorAttention: "passive",
	commentary:
		"Run non-interactive bash commands on the local leitwerk machine. The process remains open until you close or abort it.",
	actions: {
		[localShellActionIds.runCommand]: {
			label: "Run command",
			description: "Execute one bash command and return here when it finishes.",
			acceptanceState: "neutral",
			form: {
				id: "local_shell_run_command_form",
				title: "Run shell command",
				fields: [
					{
						id: "command",
						label: "Command",
						kind: "textarea",
						primaryPrompt: true,
						required: true,
						placeholder: "pwd && ls -la",
						description: "Runs as bash -lc on the leitwerk server machine.",
					},
					{
						id: "cwd",
						label: "Working directory",
						kind: "text",
						placeholder: "Use the current shell default",
						description: "Optional absolute or relative directory for this and later commands.",
					},
					{
						id: "timeoutSeconds",
						label: "Timeout seconds",
						kind: "number",
						placeholder: "120",
						description:
							"Optional per-command timeout; leave blank to use the shell default. Values are clamped between 0.1 seconds and 24 hours.",
					},
				],
				submitLabel: "Run command",
			},
			preview: { kind: "fixed_turn", turnId: localShellTurnIds.execute },
			to: localShellTurnIds.execute,
			effect: ({ ctx, input }) => ({
				state: createStateWithPendingCommand({
					state: ctx.state,
					inputValue: input,
					defaultTimeoutMs: ctx.params.timeoutMs,
				}),
			}),
		},
		[localShellActionIds.closeShell]: {
			label: "Close shell",
			description: "Complete this local shell process.",
			acceptanceState: "accepted",
			complete: true,
			preview: { kind: "terminal", lifecycleStatus: "completed" },
		},
	},
});

const executeCommandTurn = serverAutomaticTurn<
	LocalShellParams,
	LocalShellState,
	LocalShellTurnOutcome
>({
	description: "Execute local shell command",
	restartBehavior: "fail_running",
	run: executePendingCommand,
	outcomes: {
		command_finished: commandFinishedOutcome,
		command_timed_out: commandTimedOutOutcome,
		runner_error: commandRunnerErrorOutcome,
	},
});

export const localShellProcess = defineProcess<LocalShellParams, LocalShellState>({
	id: localShellProcessId,
	displayName: "Local Shell",
	entry: localShellTurnIds.open,
	paramsCodec: localShellParamsCodec,
	stateCodec: localShellStateCodec,
	initialState: createInitialLocalShellState,
	turns: {
		[localShellTurnIds.open]: openShellTurn,
		[localShellTurnIds.console]: commandConsoleTurn,
		[localShellTurnIds.execute]: executeCommandTurn,
	},
	server(api) {
		api.onCleanup(async (ctx) => {
			await abortActiveLocalShellCommandAndWait(ctx.process.id);
			if (!ctx.state.pendingCommand) {
				return undefined;
			}
			return { state: { ...ctx.state, pendingCommand: null } };
		});
	},
	launchers(api) {
		api.launcher({
			id: "local_shell_process.local_shell_ui",
			label: "Local Shell",
			description: "Open a process that can run local shell commands until you close it.",
			visibility: "ui",
			ui: {
				card: {
					title: "Local Shell",
					description:
						"Run non-interactive bash commands on the local leitwerk machine. No LLM is involved.",
				},
				launchConfigSchema: {
					id: "local_shell_launcher_form",
					title: "Local Shell",
					fields: [
						{
							id: "defaultCwd",
							label: "Default working directory",
							kind: "text",
							placeholder: process.cwd(),
							description: "Optional directory used by commands unless a command overrides it.",
							rememberRecentValues: true,
						},
						{
							id: "initialCommand",
							label: "Initial command",
							kind: "textarea",
							placeholder: "echo hello",
							description: "Optional command to run immediately after launch.",
						},
						{
							id: "timeoutSeconds",
							label: "Default timeout seconds",
							kind: "number",
							placeholder: "120",
							description:
								"Default timeout for all commands in this shell unless a command overrides it.",
						},
					],
					submitLabel: "Open shell",
				},
				resolveDefaults() {
					return {
						defaultCwd: process.cwd(),
						initialCommand: "",
						timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_MS / 1000,
					};
				},
				resolveLaunchConfig(input) {
					const validated = validateLauncherInput(input);
					if (!validated.ok) {
						return validated;
					}
					return {
						ok: true,
						launchConfig: {
							processId: localShellProcessId,
							params: {
								defaultCwd: validated.defaultCwd,
								initialCommand: validated.initialCommand,
								timeoutMs: validated.timeoutMs,
							},
							title: launcherTitle(validated),
							startTurnId: localShellTurnIds.open,
						},
					};
				},
			},
		});
	},
});

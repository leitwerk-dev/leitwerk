export const localShellProcessId = "local_shell_process";
export const localShellTurnIds = {
	open: "open_shell",
	console: "command_console",
	execute: "execute_command",
} as const;
export const localShellActionIds = {
	runCommand: "run_command",
	closeShell: "close_shell",
} as const;

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MIN_COMMAND_TIMEOUT_MS = 100;
export const MAX_COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 128 * 1024;
export const MAX_COMMAND_LENGTH_CHARS = 32_768;

export type LocalShellCommandOutcome = "finished" | "timed_out" | "runner_error";

export interface LocalShellParams {
	defaultCwd: string | null;
	initialCommand: string | null;
	timeoutMs: number;
}

export interface PendingLocalShellCommand {
	sequence: number;
	command: string;
	cwd: string | null;
	timeoutMs: number;
}

export interface LocalShellState {
	pendingCommand: PendingLocalShellCommand | null;
	defaultCwd: string | null;
	nextSequence: number;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function trimToNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function normalizeCommandInput(value: unknown): string | null {
	const command = trimToNull(value);
	if (!command) {
		return null;
	}
	if (command.length > MAX_COMMAND_LENGTH_CHARS) {
		throw new Error(`Command exceeds the maximum length of ${MAX_COMMAND_LENGTH_CHARS} characters`);
	}
	return command;
}

function finiteNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

export function normalizeTimeoutMs(value: unknown, fallback = DEFAULT_COMMAND_TIMEOUT_MS): number {
	const parsed = finiteNumber(value);
	if (parsed === null) {
		return fallback;
	}
	return Math.max(MIN_COMMAND_TIMEOUT_MS, Math.min(MAX_COMMAND_TIMEOUT_MS, Math.round(parsed)));
}

export function timeoutSecondsToMs(
	value: unknown,
	fallbackMs = DEFAULT_COMMAND_TIMEOUT_MS,
): number {
	const parsed = finiteNumber(value);
	return parsed === null ? fallbackMs : normalizeTimeoutMs(parsed * 1000, fallbackMs);
}

export function commandPreview(command: string, maxChars = 80): string {
	const singleLine = command.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxChars) {
		return singleLine;
	}
	return `${singleLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function parsePendingCommand(value: unknown): PendingLocalShellCommand | null {
	const record = asRecord(value);
	let command: string | null;
	try {
		command = normalizeCommandInput(record.command);
	} catch {
		return null;
	}
	const sequence = finiteNumber(record.sequence);
	if (!command || sequence === null || sequence < 1) {
		return null;
	}
	return {
		sequence: Math.floor(sequence),
		command,
		cwd: trimToNull(record.cwd),
		timeoutMs: normalizeTimeoutMs(record.timeoutMs),
	};
}

export const localShellParamsCodec = {
	parse(value: unknown): LocalShellParams {
		const record = asRecord(value);
		return {
			defaultCwd: trimToNull(record.defaultCwd),
			initialCommand: normalizeCommandInput(record.initialCommand),
			timeoutMs: normalizeTimeoutMs(record.timeoutMs),
		};
	},
	serialize(value: LocalShellParams): LocalShellParams {
		return value;
	},
};

export const localShellStateCodec = {
	parse(value: unknown): LocalShellState {
		const record = asRecord(value);
		const nextSequence = finiteNumber(record.nextSequence);
		return {
			pendingCommand: parsePendingCommand(record.pendingCommand),
			defaultCwd: trimToNull(record.defaultCwd),
			nextSequence: nextSequence === null || nextSequence < 1 ? 1 : Math.floor(nextSequence),
		};
	},
	serialize(value: LocalShellState): LocalShellState {
		return value;
	},
};

export function createPendingCommand(input: {
	sequence: number;
	command: string;
	cwd: string | null;
	timeoutMs: number;
}): PendingLocalShellCommand {
	const command = normalizeCommandInput(input.command);
	if (!command) {
		throw new Error("Command is required");
	}
	return {
		sequence: input.sequence,
		command,
		cwd: trimToNull(input.cwd),
		timeoutMs: normalizeTimeoutMs(input.timeoutMs),
	};
}

export function createInitialLocalShellState(params: LocalShellParams): LocalShellState {
	const pendingCommand = params.initialCommand
		? createPendingCommand({
				sequence: 1,
				command: params.initialCommand,
				cwd: params.defaultCwd,
				timeoutMs: params.timeoutMs,
			})
		: null;
	return {
		pendingCommand,
		defaultCwd: params.defaultCwd,
		nextSequence: pendingCommand ? 2 : 1,
	};
}

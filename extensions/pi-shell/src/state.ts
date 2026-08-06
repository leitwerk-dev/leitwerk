import path from "node:path";

export const piShellProcessId = "pi_shell_process";

export const piShellTurnIds = {
	open: "open_session",
	console: "prompt_console",
	runPrompt: "run_prompt",
} as const;

export const piShellActionIds = {
	sendPrompt: "send_prompt",
	close: "close_session",
} as const;

export const DEFAULT_WORKING_DIRECTORY = process.cwd();
export const MAX_PROMPT_LENGTH_CHARS = 128_000;

export interface PiShellParams {
	workingDirectory: string;
	initialPrompt: string | null;
}

export interface PiShellState {
	workingDirectory: string;
	pendingPrompt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function normalizeWorkingDirectory(value: unknown): string {
	const raw =
		typeof value === "string" && value.trim() !== "" ? value.trim() : DEFAULT_WORKING_DIRECTORY;
	return path.resolve(raw);
}

export function normalizePromptInput(value: unknown): string | null {
	const prompt = typeof value === "string" ? value.trim() : "";
	if (!prompt) {
		return null;
	}
	if (prompt.length > MAX_PROMPT_LENGTH_CHARS) {
		throw new Error(`Prompt exceeds the maximum length of ${MAX_PROMPT_LENGTH_CHARS} characters`);
	}
	return prompt;
}

function parsePersistedPrompt(value: unknown): string | null {
	try {
		return normalizePromptInput(value);
	} catch {
		return null;
	}
}

function requirePrompt(value: unknown): string {
	const prompt = normalizePromptInput(value);
	if (!prompt) {
		throw new Error("Prompt is required");
	}
	return prompt;
}

export const piShellParamsCodec = {
	parse(value: unknown): PiShellParams {
		const record = asRecord(value);
		return {
			workingDirectory: normalizeWorkingDirectory(record.workingDirectory),
			initialPrompt: normalizePromptInput(record.initialPrompt),
		};
	},
	serialize(value: PiShellParams): PiShellParams {
		return value;
	},
};

export const piShellStateCodec = {
	parse(value: unknown): PiShellState {
		const record = asRecord(value);
		return {
			workingDirectory: normalizeWorkingDirectory(record.workingDirectory),
			pendingPrompt: parsePersistedPrompt(record.pendingPrompt),
		};
	},
	serialize(value: PiShellState): PiShellState {
		return value;
	},
};

export function createInitialPiShellState(params: PiShellParams): PiShellState {
	return {
		workingDirectory: params.workingDirectory,
		pendingPrompt: params.initialPrompt,
	};
}

export function stateWithPendingPiShellPrompt(input: {
	state: PiShellState;
	prompt: unknown;
}): PiShellState {
	return {
		...input.state,
		pendingPrompt: requirePrompt(input.prompt),
	};
}

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";

/** Forward signals to an attached child and exit with its status. */
export function forwardChildLifecycle(child: ChildProcess, cleanup: () => void = () => {}): void {
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			cleanup();
			child.kill(signal);
		});
	}
	child.once("error", (error) => {
		cleanup();
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
	child.once("exit", (code, signal) => {
		cleanup();
		process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : (code ?? 1));
	});
}

export function spawnManaged(
	command: string,
	args: readonly string[],
	options: SpawnOptions = {},
): ChildProcess {
	return spawn(command, [...args], {
		...options,
		// Development is POSIX-only. Giving every long-running child its own
		// process group lets shutdown terminate npm/shell/esbuild descendants too.
		detached: true,
	});
}

export function spawnTsx(scriptPath: string, options: SpawnOptions = {}): ChildProcess {
	return spawnManaged(
		process.execPath,
		["--conditions=source", "--import", "tsx", scriptPath],
		options,
	);
}

/**
 * Spawns the top-level dev session in the caller's foreground process group.
 * The terminal must deliver Ctrl+C to both the supervisor and the session so
 * the session can clean up even when npm exits before the supervisor does.
 */
export function spawnAttachedTsx(scriptPath: string, options: SpawnOptions = {}): ChildProcess {
	return spawn(process.execPath, ["--conditions=source", "--import", "tsx", scriptPath], {
		...options,
		detached: false,
	});
}

export function waitForSuccess(child: ChildProcess): Promise<boolean> {
	return new Promise((resolve) => {
		child.once("error", () => resolve(false));
		child.once("exit", (code) => resolve(code === 0));
	});
}

export interface UnexpectedChildFailure {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
}

/** Observes a child once, ignoring exits that the caller explicitly initiated. */
export function observeUnexpectedChildFailure(
	child: ChildProcess,
	isExpected: () => boolean,
	onUnexpected: (failure: UnexpectedChildFailure) => void,
): void {
	let handled = false;
	const report = (failure: UnexpectedChildFailure): void => {
		if (handled) return;
		handled = true;
		if (!isExpected()) onUnexpected(failure);
	};
	child.once("error", (error) => report({ code: null, signal: null, error }));
	child.once("exit", (code, signal) => report({ code, signal }));
}

/** Coalesces concurrent requests into at most one follow-up run. */
export function createCoalescedRunner(
	task: () => Promise<void>,
	isStopped: () => boolean,
): { run(): void; isRunning(): boolean } {
	let running = false;
	let queued = false;
	return {
		run() {
			if (running || isStopped()) {
				queued = true;
				return;
			}
			running = true;
			void (async () => {
				try {
					do {
						queued = false;
						await task();
					} while (queued && !isStopped());
				} finally {
					running = false;
				}
			})();
		},
		isRunning: () => running,
	};
}

export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
	if (!child.pid) return;
	try {
		// A process group can outlive its leader (notably when npm exits before
		// vite/esbuild). Do not use the ChildProcess exit fields as a guard here.
		process.kill(-child.pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

export function isProcessGroupAlive(child: ChildProcess): boolean {
	if (!child.pid) return false;
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}

async function pollProcessGroupUntilGone(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isProcessGroupAlive(child)) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		await new Promise((resolve) => setTimeout(resolve, Math.min(25, remainingMs)));
	}
	return true;
}

export function stopManagedForExit(
	child: ChildProcess,
	exitCode: number,
	normalGraceMs: number,
	interruptGraceMs: number,
): Promise<void> {
	const interrupted = exitCode === 130;
	return stopManaged(child, {
		signal: interrupted ? "SIGINT" : "SIGTERM",
		graceMs: interrupted ? interruptGraceMs : normalGraceMs,
	});
}

export async function stopAttached(
	child: ChildProcess,
	options: { signal?: NodeJS.Signals; graceMs?: number } = {},
): Promise<void> {
	if (!child.pid) {
		child.once("error", () => {});
		return;
	}
	if (child.exitCode !== null || child.signalCode !== null) return;

	const signal = options.signal ?? "SIGTERM";
	const graceMs = options.graceMs ?? 10_000;
	await new Promise<void>((resolve) => {
		let settled = false;
		let forceTimer: NodeJS.Timeout | null = null;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(graceTimer);
			if (forceTimer) clearTimeout(forceTimer);
			resolve();
		};
		const graceTimer = setTimeout(() => {
			child.kill("SIGKILL");
			forceTimer = setTimeout(finish, 1_000);
		}, graceMs);
		child.once("exit", finish);
		child.once("close", finish);
		child.once("error", finish);
		child.kill(signal);
		if (child.exitCode !== null || child.signalCode !== null) finish();
	});
}

export function stopAttachedForExit(
	child: ChildProcess,
	exitCode: number,
	normalGraceMs: number,
	interruptGraceMs: number,
): Promise<void> {
	const interrupted = exitCode === 130;
	return stopAttached(child, {
		signal: interrupted ? "SIGINT" : "SIGTERM",
		graceMs: interrupted ? interruptGraceMs : normalGraceMs,
	});
}

export async function stopManaged(
	child: ChildProcess,
	options: { signal?: NodeJS.Signals; graceMs?: number } = {},
): Promise<void> {
	if (!child.pid) {
		// A failed spawn reports through an asynchronous error event. Consume it
		// even though there is no process group to stop.
		child.once("error", () => {});
		return;
	}

	signalProcessGroup(child, options.signal ?? "SIGTERM");
	if (await pollProcessGroupUntilGone(child, options.graceMs ?? 10_000)) return;

	signalProcessGroup(child, "SIGKILL");
	await pollProcessGroupUntilGone(child, 1_000);
}

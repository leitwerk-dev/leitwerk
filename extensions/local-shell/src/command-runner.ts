import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { sanitizeWorkerSubprocessEnv } from "@leitwerk-dev/process-sdk";
import {
	DEFAULT_OUTPUT_LIMIT_BYTES,
	type LocalShellCommandOutcome,
	normalizeTimeoutMs,
} from "./state.js";

export interface ShellCommandResult {
	outcome: LocalShellCommandOutcome;
	cwd: string;
	exitCode: number | null;
	signal: string | null;
	durationMs: number;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	errorMessage: string | null;
	timedOut: boolean;
}

export interface RunShellCommandInput {
	command: string;
	cwd?: string | null;
	timeoutMs?: number;
	outputLimitBytes?: number;
	killGraceMs?: number;
	/** Grace after shell exit before force-closing inherited stdio held by escaped descendants. */
	stdioCloseGraceMs?: number;
	/** Grace after SIGKILL before resolving even if stdio is still held open. */
	forceKillSettleMs?: number;
	/** Stable key used to persist process-group cleanup metadata across server crashes. */
	trackingKey?: string | null;
	signal?: AbortSignal;
}

interface PersistedProcessGroupRecord {
	version: 1;
	trackingKey: string;
	pid: number;
	ownerPid: number;
	startedAt: string;
}

const activeProcessGroupPids = new Set<number>();
let exitCleanupInstalled = false;
const DEFAULT_STDIO_CLOSE_GRACE_MS = 250;
const DEFAULT_FORCE_KILL_SETTLE_MS = 250;
const REGISTRY_ENV_VAR = "LEITWERK_LOCAL_SHELL_REGISTRY_DIR";

function localShellRegistryDir(): string {
	const override = process.env[REGISTRY_ENV_VAR]?.trim();
	if (override) {
		return path.resolve(override);
	}
	const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
	return path.join(tmpdir(), `leitwerk-local-shell-${uid}`);
}

function ensureLocalShellRegistryDir(): string {
	const dir = localShellRegistryDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Best-effort hardening for temp registry permissions.
	}
	return dir;
}

function persistedRecordPath(trackingKey: string): string {
	const digest = createHash("sha256").update(trackingKey).digest("hex");
	return path.join(ensureLocalShellRegistryDir(), `${digest}.json`);
}

function persistProcessGroupRecord(
	trackingKey: string | null | undefined,
	pid: number,
): () => void {
	const normalizedKey = trackingKey?.trim();
	if (!normalizedKey) {
		return () => {};
	}
	try {
		const filePath = persistedRecordPath(normalizedKey);
		const tmpPath = `${filePath}.${process.pid}.tmp`;
		const record: PersistedProcessGroupRecord = {
			version: 1,
			trackingKey: normalizedKey,
			pid,
			ownerPid: process.pid,
			startedAt: new Date().toISOString(),
		};
		writeFileSync(tmpPath, JSON.stringify(record), { mode: 0o600 });
		renameSync(tmpPath, filePath);
		return () => {
			try {
				rmSync(filePath, { force: true });
			} catch {
				// Best-effort cleanup for stale command metadata.
			}
		};
	} catch {
		return () => {};
	}
}

function parsePersistedProcessGroupRecord(value: unknown): PersistedProcessGroupRecord | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || typeof record.trackingKey !== "string") {
		return null;
	}
	const pid = record.pid;
	const ownerPid = record.ownerPid;
	if (!Number.isInteger(pid) || (pid as number) <= 1 || pid === process.pid) {
		return null;
	}
	if (!Number.isInteger(ownerPid) || (ownerPid as number) <= 1) {
		return null;
	}
	const startedAt = typeof record.startedAt === "string" ? record.startedAt : "";
	return {
		version: 1,
		trackingKey: record.trackingKey,
		pid: pid as number,
		ownerPid: ownerPid as number,
		startedAt,
	};
}

function isProcessAlive(pid: number): boolean {
	if (pid === process.pid) {
		return true;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
	}
}

function killProcessGroupPid(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		// Fall back to signalling only the shell process.
	}
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

export function cleanupPersistedLocalShellProcessGroups(
	options: { includeLiveOwners?: boolean } = {},
): number {
	let files: string[];
	try {
		files = readdirSync(localShellRegistryDir());
	} catch {
		return 0;
	}
	let signalled = 0;
	for (const fileName of files) {
		if (!fileName.endsWith(".json")) {
			continue;
		}
		const filePath = path.join(localShellRegistryDir(), fileName);
		let shouldRemoveRecord = true;
		try {
			const record = parsePersistedProcessGroupRecord(
				JSON.parse(readFileSync(filePath, "utf8")) as unknown,
			);
			if (record && !options.includeLiveOwners && isProcessAlive(record.ownerPid)) {
				shouldRemoveRecord = false;
			} else if (record && killProcessGroupPid(record.pid, "SIGKILL")) {
				signalled += 1;
			}
		} catch {
			// Invalid/stale registry entries are removed below.
		}
		if (!shouldRemoveRecord) {
			continue;
		}
		try {
			rmSync(filePath, { force: true });
		} catch {
			// Best-effort stale metadata cleanup.
		}
	}
	return signalled;
}

function installExitCleanup(): void {
	if (exitCleanupInstalled) {
		return;
	}
	exitCleanupInstalled = true;
	process.once("exit", () => {
		for (const pid of activeProcessGroupPids) {
			killProcessGroupPid(pid, "SIGKILL");
		}
	});
}

function trackChildProcessGroup(child: ChildProcess, trackingKey?: string | null): () => void {
	const pid = child.pid;
	if (!pid) {
		return () => {};
	}
	activeProcessGroupPids.add(pid);
	const removePersistedRecord = persistProcessGroupRecord(trackingKey, pid);
	installExitCleanup();
	return () => {
		activeProcessGroupPids.delete(pid);
		removePersistedRecord();
	};
}

class TailBuffer {
	private buffer = Buffer.alloc(0);
	private totalBytes = 0;

	constructor(private readonly limitBytes: number) {}

	append(chunk: Buffer | string): void {
		const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		this.totalBytes += nextChunk.length;
		if (this.limitBytes <= 0) {
			return;
		}
		const next = Buffer.concat([this.buffer, nextChunk]);
		this.buffer =
			next.length > this.limitBytes ? next.subarray(next.length - this.limitBytes) : next;
	}

	get truncated(): boolean {
		return this.totalBytes > this.buffer.length;
	}

	toString(): string {
		return this.buffer.toString("utf8");
	}
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}

function errorResult(input: {
	cwd: string;
	startedAt: number;
	message: string;
	stdout?: TailBuffer;
	stderr?: TailBuffer;
}): ShellCommandResult {
	return {
		outcome: "runner_error",
		cwd: input.cwd,
		exitCode: null,
		signal: null,
		durationMs: Math.max(0, Math.round(performance.now() - input.startedAt)),
		stdout: input.stdout?.toString() ?? "",
		stderr: input.stderr?.toString() ?? "",
		stdoutTruncated: input.stdout?.truncated ?? false,
		stderrTruncated: input.stderr?.truncated ?? false,
		errorMessage: input.message,
		timedOut: false,
	};
}

export function resolveCommandCwd(
	cwd: string | null | undefined,
	baseCwd = process.cwd(),
): { ok: true; cwd: string } | { ok: false; cwd: string; message: string } {
	const requested = cwd?.trim() || baseCwd;
	const resolved = path.resolve(baseCwd, requested);
	try {
		const stat = statSync(resolved);
		if (!stat.isDirectory()) {
			return {
				ok: false,
				cwd: resolved,
				message: `Working directory is not a directory: ${resolved}`,
			};
		}
		return { ok: true, cwd: resolved };
	} catch (error) {
		return {
			ok: false,
			cwd: resolved,
			message: `Working directory is not available: ${toErrorMessage(error)}`,
		};
	}
}

function signalChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) {
		child.kill(signal);
		return;
	}
	try {
		process.kill(-child.pid, signal);
		return;
	} catch {
		// Fall back to signalling only the shell process. This can happen if the
		// platform refuses process-group signalling or the process has already exited.
	}
	try {
		child.kill(signal);
	} catch {
		// Best-effort termination; close/error handlers settle the command result.
	}
}

function outputLimit(input: number | undefined): number {
	if (typeof input !== "number" || !Number.isFinite(input)) {
		return DEFAULT_OUTPUT_LIMIT_BYTES;
	}
	return Math.max(0, Math.floor(input));
}

function graceMs(input: number | undefined, fallback: number): number {
	if (typeof input !== "number" || !Number.isFinite(input)) {
		return fallback;
	}
	return Math.max(0, Math.round(input));
}

export async function runShellCommand(input: RunShellCommandInput): Promise<ShellCommandResult> {
	const startedAt = performance.now();
	const command = input.command.trim();
	const resolvedCwd = resolveCommandCwd(input.cwd);
	if (!command) {
		return errorResult({
			cwd: resolvedCwd.cwd,
			startedAt,
			message: "Command is required",
		});
	}
	if (!resolvedCwd.ok) {
		return errorResult({
			cwd: resolvedCwd.cwd,
			startedAt,
			message: resolvedCwd.message,
		});
	}
	if (input.signal?.aborted) {
		return errorResult({
			cwd: resolvedCwd.cwd,
			startedAt,
			message: "Command was aborted before it started",
		});
	}

	const limit = outputLimit(input.outputLimitBytes);
	const stdout = new TailBuffer(limit);
	const stderr = new TailBuffer(limit);
	const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
	const killGraceMs = graceMs(input.killGraceMs, 2_000);
	const stdioCloseGraceMs = graceMs(input.stdioCloseGraceMs, DEFAULT_STDIO_CLOSE_GRACE_MS);
	const forceKillSettleMs = graceMs(input.forceKillSettleMs, DEFAULT_FORCE_KILL_SETTLE_MS);
	let child: ChildProcess;
	try {
		child = spawn("bash", ["-lc", command], {
			cwd: resolvedCwd.cwd,
			detached: true,
			env: sanitizeWorkerSubprocessEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		return errorResult({
			cwd: resolvedCwd.cwd,
			startedAt,
			message: toErrorMessage(error),
			stdout,
			stderr,
		});
	}

	return new Promise<ShellCommandResult>((resolve) => {
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
		let killTimer: ReturnType<typeof setTimeout> | null = null;
		let exitCloseTimer: ReturnType<typeof setTimeout> | null = null;
		let forceSettleTimer: ReturnType<typeof setTimeout> | null = null;
		let terminationStarted = false;
		let observedExitCode: number | null = null;
		let observedSignal: NodeJS.Signals | null = null;

		const untrackChildProcessGroup = trackChildProcessGroup(child, input.trackingKey);

		const cleanup = () => {
			untrackChildProcessGroup();
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
				timeoutTimer = null;
			}
			if (killTimer) {
				clearTimeout(killTimer);
				killTimer = null;
			}
			if (exitCloseTimer) {
				clearTimeout(exitCloseTimer);
				exitCloseTimer = null;
			}
			if (forceSettleTimer) {
				clearTimeout(forceSettleTimer);
				forceSettleTimer = null;
			}
			input.signal?.removeEventListener("abort", onAbort);
		};

		const buildCompletionResult = (
			exitCode: number | null,
			signal: NodeJS.Signals | null,
		): ShellCommandResult => {
			const outcome: LocalShellCommandOutcome = aborted
				? "runner_error"
				: timedOut
					? "timed_out"
					: "finished";
			return {
				outcome,
				cwd: resolvedCwd.cwd,
				exitCode,
				signal,
				durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
				stdout: stdout.toString(),
				stderr: stderr.toString(),
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
				errorMessage: aborted ? "Command was aborted" : null,
				timedOut,
			};
		};

		const finish = (result: ShellCommandResult) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve(result);
		};

		const destroyStdio = () => {
			child.stdout?.destroy();
			child.stderr?.destroy();
		};

		const forceFinish = () => {
			if (settled) {
				return;
			}
			destroyStdio();
			finish(buildCompletionResult(observedExitCode, observedSignal));
		};

		const scheduleForceSettleAfterKill = () => {
			if (forceSettleTimer || settled) {
				return;
			}
			forceSettleTimer = setTimeout(forceFinish, forceKillSettleMs);
			forceSettleTimer.unref?.();
		};

		const terminate = () => {
			if (terminationStarted) {
				return;
			}
			terminationStarted = true;
			signalChildProcess(child, "SIGTERM");
			killTimer = setTimeout(() => {
				signalChildProcess(child, "SIGKILL");
				scheduleForceSettleAfterKill();
			}, killGraceMs);
			killTimer.unref?.();
		};

		function onAbort() {
			if (settled) {
				return;
			}
			aborted = true;
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
				timeoutTimer = null;
			}
			terminate();
		}

		child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

		child.once("error", (error) => {
			finish(
				errorResult({
					cwd: resolvedCwd.cwd,
					startedAt,
					message: toErrorMessage(error),
					stdout,
					stderr,
				}),
			);
		});

		child.once("exit", (exitCode, signal) => {
			observedExitCode = exitCode;
			observedSignal = signal;
			if (!timedOut && !aborted && timeoutTimer) {
				clearTimeout(timeoutTimer);
				timeoutTimer = null;
			}
			if (settled) {
				return;
			}
			exitCloseTimer = setTimeout(forceFinish, stdioCloseGraceMs);
			exitCloseTimer.unref?.();
		});

		child.once("close", (exitCode, signal) => {
			observedExitCode = exitCode;
			observedSignal = signal;
			finish(buildCompletionResult(exitCode, signal));
		});

		input.signal?.addEventListener("abort", onAbort, { once: true });
		if (input.signal?.aborted) {
			onAbort();
		}
		if (!settled) {
			timeoutTimer = setTimeout(() => {
				if (settled || aborted) {
					return;
				}
				timedOut = true;
				terminate();
			}, timeoutMs);
			timeoutTimer.unref?.();
		}
	});
}

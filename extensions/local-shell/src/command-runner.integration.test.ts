import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	WORKER_IPC_CONNECT_TOKEN_ENV,
	WORKER_IPC_RECONNECT_ENV,
	WORKER_SNAPSHOT_TOKEN_ENV,
} from "@leitwerk-dev/worker-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupPersistedLocalShellProcessGroups, runShellCommand } from "./command-runner.js";

const tempDirs: string[] = [];
const registryEnvVar = "LEITWERK_LOCAL_SHELL_REGISTRY_DIR";
let previousRegistryDir: string | undefined;

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "local-shell-runner-"));
	tempDirs.push(dir);
	return dir;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number) {
	return Promise.race([
		promise.then((value) => ({ settled: true as const, value })),
		new Promise<{ settled: false }>((resolve) =>
			setTimeout(() => resolve({ settled: false }), timeoutMs),
		),
	]);
}

async function waitForValue<T>(read: () => T, accept: (value: T) => boolean): Promise<T> {
	for (let attempt = 0; attempt < 250; attempt += 1) {
		const value = read();
		if (accept(value)) {
			return value;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Timed out waiting for value");
}

function killProcessGroupFromPidFile(pidFile: string): void {
	if (!existsSync(pidFile)) {
		return;
	}
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	if (!Number.isInteger(pid) || pid <= 0) {
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Best-effort cleanup for intentionally escaped test processes.
		}
	}
}

beforeEach(() => {
	previousRegistryDir = process.env[registryEnvVar];
	process.env[registryEnvVar] = tempDir();
});

afterEach(() => {
	cleanupPersistedLocalShellProcessGroups({ includeLiveOwners: true });
	if (previousRegistryDir === undefined) {
		delete process.env[registryEnvVar];
	} else {
		process.env[registryEnvVar] = previousRegistryDir;
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("runShellCommand", () => {
	it("runs a command in the requested working directory and captures stdout and stderr", async () => {
		const cwd = tempDir();
		writeFileSync(path.join(cwd, "marker.txt"), "marker", "utf8");

		const result = await runShellCommand({
			command: "pwd; ls marker.txt; echo stderr-line >&2",
			cwd,
			timeoutMs: 5_000,
		});

		expect(result.outcome).toBe("finished");
		expect(result.exitCode).toBe(0);
		expect(result.cwd).toBe(cwd);
		expect(result.stdout).toContain(cwd);
		expect(result.stdout).toContain("marker.txt");
		expect(result.stderr).toContain("stderr-line");
		expect(result.errorMessage).toBeNull();
	});

	it("does not leak worker credentials into command environments", async () => {
		const previous = {
			connect: process.env[WORKER_IPC_CONNECT_TOKEN_ENV],
			reconnect: process.env[WORKER_IPC_RECONNECT_ENV],
			snapshot: process.env[WORKER_SNAPSHOT_TOKEN_ENV],
		};
		process.env[WORKER_IPC_CONNECT_TOKEN_ENV] = "connect-secret";
		process.env[WORKER_IPC_RECONNECT_ENV] = "1";
		process.env[WORKER_SNAPSHOT_TOKEN_ENV] = "snapshot-secret";
		try {
			const result = await runShellCommand({
				command: `node -e "console.log([process.env.${WORKER_IPC_CONNECT_TOKEN_ENV}, process.env.${WORKER_IPC_RECONNECT_ENV}, process.env.${WORKER_SNAPSHOT_TOKEN_ENV}].map(v => v === undefined ? 'missing' : v).join(','))"`,
				cwd: tempDir(),
				timeoutMs: 5_000,
			});

			expect(result.outcome).toBe("finished");
			expect(result.stdout.trim()).toBe("missing,missing,missing");
		} finally {
			if (previous.connect === undefined) delete process.env[WORKER_IPC_CONNECT_TOKEN_ENV];
			else process.env[WORKER_IPC_CONNECT_TOKEN_ENV] = previous.connect;
			if (previous.reconnect === undefined) delete process.env[WORKER_IPC_RECONNECT_ENV];
			else process.env[WORKER_IPC_RECONNECT_ENV] = previous.reconnect;
			if (previous.snapshot === undefined) delete process.env[WORKER_SNAPSHOT_TOKEN_ENV];
			else process.env[WORKER_SNAPSHOT_TOKEN_ENV] = previous.snapshot;
		}
	});

	it("treats a non-zero exit as a finished command result", async () => {
		const result = await runShellCommand({
			command: "echo failed >&2; exit 7",
			cwd: tempDir(),
			timeoutMs: 5_000,
		});

		expect(result.outcome).toBe("finished");
		expect(result.exitCode).toBe(7);
		expect(result.stderr).toContain("failed");
	});

	it("terminates commands that exceed their timeout", async () => {
		const result = await runShellCommand({
			command: "sleep 5",
			cwd: tempDir(),
			timeoutMs: 250,
			killGraceMs: 100,
			forceKillSettleMs: 100,
		});

		expect(result.outcome).toBe("timed_out");
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBeNull();
	});

	it("keeps only the retained tail when output exceeds the byte limit", async () => {
		const result = await runShellCommand({
			command: "printf abcdef",
			cwd: tempDir(),
			timeoutMs: 5_000,
			outputLimitBytes: 3,
		});

		expect(result.outcome).toBe("finished");
		expect(result.stdout).toBe("def");
		expect(result.stdoutTruncated).toBe(true);
	});

	it("returns runner errors for invalid input without spawning a command", async () => {
		const missingCommand = await runShellCommand({ command: "   ", cwd: tempDir() });
		expect(missingCommand.outcome).toBe("runner_error");
		expect(missingCommand.errorMessage).toContain("Command is required");

		const invalidCwd = await runShellCommand({
			command: "pwd",
			cwd: path.join(tempDir(), "missing"),
		});
		expect(invalidCwd.outcome).toBe("runner_error");
		expect(invalidCwd.errorMessage).toContain("Working directory is not available");

		const invalidSpawnArgs = await runShellCommand({
			command: "echo before\0after",
			cwd: tempDir(),
		});
		expect(invalidSpawnArgs.outcome).toBe("runner_error");
		expect(invalidSpawnArgs.errorMessage).toEqual(expect.any(String));
	});

	it("aborts an active command through an AbortSignal", async () => {
		const controller = new AbortController();
		const promise = runShellCommand({
			command: "sleep 5",
			cwd: tempDir(),
			timeoutMs: 5_000,
			killGraceMs: 100,
			forceKillSettleMs: 100,
			signal: controller.signal,
		});

		controller.abort();
		const result = await promise;

		expect(result.outcome).toBe("runner_error");
		expect(result.errorMessage).toContain("aborted");
	});

	it("keeps an operator abort from being reclassified as a later timeout", async () => {
		const controller = new AbortController();
		const promise = runShellCommand({
			command: "trap '' TERM; sleep 5",
			cwd: tempDir(),
			timeoutMs: 5_000,
			killGraceMs: 100,
			forceKillSettleMs: 100,
			signal: controller.signal,
		});

		await new Promise((resolve) => setTimeout(resolve, 100));
		controller.abort();
		const result = await promise;

		expect(result.outcome).toBe("runner_error");
		expect(result.timedOut).toBe(false);
		expect(result.errorMessage).toContain("aborted");
	});

	it("persists process-group metadata so stale commands can be cleaned up", async () => {
		const promise = runShellCommand({
			command: "sleep 5",
			cwd: tempDir(),
			timeoutMs: 10_000,
			trackingKey: "proc_cleanup_test",
		});

		const cleanedUp = await waitForValue(
			() => cleanupPersistedLocalShellProcessGroups({ includeLiveOwners: true }),
			(count) => count > 0,
		);
		const result = await promise;

		expect(cleanedUp).toBe(1);
		expect(result.signal).toBe("SIGKILL");
	});

	it("settles a finished command when a background descendant keeps stdio open", async () => {
		const cwd = tempDir();
		const pidFile = path.join(cwd, "escaped-finished.pid");
		const escapedNodeScript = [
			"const fs = require('node:fs');",
			"const { spawn } = require('node:child_process');",
			"const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { detached: true, stdio: ['ignore', 1, 2] });",
			`fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
			"child.unref();",
		].join("\n");
		const promise = runShellCommand({
			command: `${shellQuote(process.execPath)} -e ${shellQuote(escapedNodeScript)}`,
			cwd,
			timeoutMs: 5_000,
			stdioCloseGraceMs: 100,
		});
		await waitForValue(
			() => existsSync(pidFile),
			(created) => created,
		);

		const settled = await settleWithin(promise, 3_000);
		killProcessGroupFromPidFile(pidFile);
		if (!settled.settled) {
			await settleWithin(promise, 2_000);
			throw new Error("finished command did not settle after its shell exited");
		}

		expect(settled.value.outcome).toBe("finished");
		expect(settled.value.timedOut).toBe(false);
	});

	it("settles a timed-out command even when a descendant escapes the shell process group", async () => {
		const cwd = tempDir();
		const pidFile = path.join(cwd, "escaped-timeout.pid");
		const escapedNodeScript = [
			"const fs = require('node:fs');",
			"const { spawn } = require('node:child_process');",
			"const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { detached: true, stdio: ['ignore', 1, 2] });",
			`fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
			"child.unref();",
		].join("\n");
		const promise = runShellCommand({
			command: `${shellQuote(process.execPath)} -e ${shellQuote(escapedNodeScript)}; sleep 5`,
			cwd,
			timeoutMs: 250,
			killGraceMs: 100,
			stdioCloseGraceMs: 100,
			forceKillSettleMs: 100,
		});

		const settled = await settleWithin(promise, 3_000);
		killProcessGroupFromPidFile(pidFile);
		if (!settled.settled) {
			await settleWithin(promise, 3_000);
			throw new Error("timed-out command did not settle after killing the wrapper process");
		}

		expect(settled.value.outcome).toBe("timed_out");
		expect(settled.value.timedOut).toBe(true);
	});
});

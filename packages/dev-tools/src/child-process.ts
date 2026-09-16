import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

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

export async function waitForBackendReady(
	child: ChildProcess,
	url: string | URL,
	isStopping = () => false,
): Promise<boolean> {
	const deadline = Date.now() + 30_000;
	while (
		!isStopping() &&
		child.exitCode === null &&
		child.signalCode === null &&
		Date.now() < deadline
	) {
		try {
			if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return true;
		} catch {
			// The backend is still starting.
		}
		await delay(100);
	}
	return false;
}

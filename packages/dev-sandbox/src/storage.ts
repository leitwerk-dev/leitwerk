import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** @internal */
export function assertSandboxPath(root: string, candidate: string): void {
	const relative = path.relative(root, candidate);
	if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
		throw new Error("Path escapes sandbox");
	let current = root;
	for (const part of ["", ...relative.split(path.sep)]) {
		current = path.join(current, part);
		if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
			throw new Error("Sandbox storage must not be a symlink");
	}
}
/** @internal */
export function sandboxDirectory(workspaceRoot: string): string {
	const directory = path.join(workspaceRoot, ".leitwerk", "sandbox");
	assertSandboxPath(workspaceRoot, directory);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return directory;
}
/** @internal */
export function processIdentity(pid: number): string | null {
	if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid sandbox supervisor pid");
	try {
		return execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
			encoding: "utf8",
		}).trim();
	} catch (error) {
		if ((error as { status?: number }).status === 1) return null;
		throw error;
	}
}
/** @internal */
export async function resetSandbox(
	workspaceRoot: string,
	options: {
		/** @internal */
		shutdownTimeoutMs?: number;
	} = {},
): Promise<void> {
	const sandbox = sandboxDirectory(workspaceRoot);
	const directories = ["scripted", "real"].map((mode) => path.join(sandbox, mode));
	// Check all owners before removing any retained state.
	for (const directory of directories) {
		const pidFile = path.join(directory, "supervisor.pid");
		assertSandboxPath(workspaceRoot, pidFile);
		if (!existsSync(pidFile)) continue;
		const owner = JSON.parse(readFileSync(pidFile, "utf8"));
		if (owner.shutdownFailed)
			throw new Error(
				`Supervisor shutdown was not confirmed; storage was retained. Stop remaining sandbox processes, then remove ${pidFile} before resetting.`,
			);
		const identity = processIdentity(owner.pid);
		if (identity && identity !== owner.identity)
			throw new Error("Supervisor PID was reused; refusing to signal an unrelated process");
		if (identity) {
			process.kill(owner.pid, "SIGTERM");
			const deadline = Date.now() + (options.shutdownTimeoutMs ?? 35_000);
			while (existsSync(pidFile) && Date.now() < deadline) await delay(100);
			if (existsSync(pidFile)) throw new Error("Sandbox did not stop; storage was retained");
		}
	}
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
}

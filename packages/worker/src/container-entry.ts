import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const PRIVATE_DOCKER_ENV = "LEITWERK_PRIVATE_DOCKER";
const DEFAULT_PROCESS_VOLUME_MOUNT_PATH = "/state";
const DOCKER_SOCKET = "/var/run/docker.sock";
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

interface EntrypointDeps {
	spawn: typeof spawn;
	dockerInfo: () => Promise<void>;
	mkdir: typeof mkdir;
	remove: typeof rm;
	now: () => number;
	delay: (ms: number) => Promise<void>;
	warn: (message: string) => void;
}

function boundedAppend(current: string, chunk: Buffer | string): string {
	const next = current + chunk.toString();
	return Buffer.byteLength(next) <= MAX_DIAGNOSTIC_BYTES
		? next
		: Buffer.from(next).subarray(-MAX_DIAGNOSTIC_BYTES).toString();
}

function workerEntryPath(): string {
	return fileURLToPath(new URL("./worker-entry.js", import.meta.url));
}

function waitForExit(
	child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function stop(child: ChildProcess | undefined, graceMs = 5_000): Promise<void> {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = waitForExit(child);
	child.kill("SIGTERM");
	if (graceMs > 0) {
		await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, graceMs))]);
	}
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 100))]);
	}
}

export async function runWorkerContainerEntrypoint(
	env: NodeJS.ProcessEnv = process.env,
	deps: EntrypointDeps = {
		spawn,
		dockerInfo: () =>
			promisify(execFile)("docker", ["--host", `unix://${DOCKER_SOCKET}`, "info"], {
				env: { ...process.env, DOCKER_HOST: `unix://${DOCKER_SOCKET}` },
			}).then(() => undefined),
		mkdir,
		remove: rm,
		now: Date.now,
		delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		warn: (message) => console.warn(message),
	},
): Promise<number> {
	let daemon: ChildProcess | undefined;
	let worker: ChildProcess | undefined;
	let terminating = false;
	const terminate = () => {
		terminating = true;
		void Promise.all([stop(worker), stop(daemon)]);
	};
	process.once("SIGTERM", terminate);
	process.once("SIGINT", terminate);

	try {
		if (env[PRIVATE_DOCKER_ENV] !== "1") {
			worker = deps.spawn(process.execPath, [workerEntryPath()], { stdio: "inherit", env });
			const exit = await waitForExit(worker);
			return exit.code ?? (terminating ? 0 : 1);
		}

		const dockerDataRoot = `${env.LEITWERK_PROCESS_VOLUME_MOUNT_PATH ?? DEFAULT_PROCESS_VOLUME_MOUNT_PATH}/tooling/docker`;
		await deps.mkdir(dockerDataRoot, { recursive: true });
		await deps.mkdir("/var/run", { recursive: true });
		const timeoutMs = Number.parseInt(env.LEITWERK_WORKER_STARTUP_TIMEOUT_MS ?? "60000", 10);
		const configuredDeadlineMs = Number.parseInt(env.LEITWERK_WORKER_STARTUP_DEADLINE_MS ?? "", 10);
		const startupDeadlineMs = Number.isFinite(configuredDeadlineMs)
			? configuredDeadlineMs
			: deps.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 60_000);
		let recovered = false;
		let firstSummary = "";

		for (let attempt = 0; attempt < 2; attempt += 1) {
			let diagnostic = "";
			daemon = deps.spawn(
				"dockerd",
				[
					"--data-root",
					dockerDataRoot,
					"--host",
					`unix://${DOCKER_SOCKET}`,
					"--pidfile",
					"/var/run/leitwerk-dockerd.pid",
				],
				{ stdio: ["ignore", "pipe", "pipe"], env },
			);
			daemon.stdout?.on("data", (chunk) => {
				diagnostic = boundedAppend(diagnostic, chunk);
			});
			daemon.stderr?.on("data", (chunk) => {
				diagnostic = boundedAppend(diagnostic, chunk);
			});
			let exited = false;
			const daemonExit = waitForExit(daemon).then((value) => {
				exited = true;
				return value;
			});
			while (!exited && deps.now() < startupDeadlineMs) {
				try {
					await deps.dockerInfo();
					if (exited) break;
					if (recovered) {
						deps.warn(
							`Private Docker daemon recovered after resetting its data root: ${firstSummary}`,
						);
					}
					worker = deps.spawn(process.execPath, [workerEntryPath()], { stdio: "inherit", env });
					const winner = await Promise.race([
						waitForExit(worker).then((exit) => ({ source: "worker" as const, exit })),
						daemonExit.then((exit) => ({ source: "daemon" as const, exit })),
					]);
					if (!terminating) {
						await stop(winner.source === "worker" ? daemon : worker);
					}
					return winner.exit.code ?? (terminating ? 0 : 1);
				} catch {
					await deps.delay(250);
				}
			}
			if (!exited) {
				await stop(daemon, 0);
				daemon = undefined;
				throw new Error(
					`Private Docker daemon readiness timed out; ${diagnostic || "no diagnostic"}`,
				);
			}
			const exit = await daemonExit;
			const summary = `exit=${exit.code ?? exit.signal ?? "unknown"}; ${diagnostic || "no diagnostic"}`;
			if (attempt === 0) {
				firstSummary = summary;
				await deps.remove(dockerDataRoot, { recursive: true, force: true });
				await deps.mkdir(dockerDataRoot, { recursive: true });
				recovered = true;
				continue;
			}
			throw new Error(
				`Private Docker daemon failed twice; first: ${firstSummary}; second: ${summary}`,
			);
		}
		return 1;
	} finally {
		process.removeListener("SIGTERM", terminate);
		process.removeListener("SIGINT", terminate);
		await Promise.all([stop(worker), stop(daemon)]);
	}
}

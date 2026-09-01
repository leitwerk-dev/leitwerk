import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createFilesystemProcessStateExporter } from "./filesystem-process-state-exporter.js";
import { UnitExitNotifier } from "./runner-utils.js";
import type {
	LocalStartWorkerInput,
	ProcessStateExporter,
	StopWorkerOptions,
	WorkerExitInfo,
	WorkerRunner,
	WorkerUnit,
	WorkerUnitDescriptor,
	WorkerUnitRef,
} from "./types.js";

export const DEFAULT_LOCAL_WORKER_ENTRY_SPECIFIER = "@leitwerk-dev/worker/worker-entry";

export interface LocalWorkerRunnerOptions {
	/** Command used to launch the worker. Defaults to `node`. */
	command?: string;
	/** Worker entry args. The default package subpath is resolved to the installed entry file. */
	args?: readonly string[];
	/** Working directory for the spawned worker. Defaults to the installed server package dir. */
	cwd?: string;
	/** Process storage roots used by the read-only session exporter. */
	processWorkspacesDir?: string;
	treeFilesDir?: string;
	/** Explicit acknowledgement that Docker processes inherit host Docker authority. */
	allowHostDocker?: boolean;
	/** Test seam. Production uses node's spawn directly. */
	localWorkerSpawnImpl?: typeof spawn;
	/** Test seam for the shared host-Docker preflight. */
	dockerPreflightImpl?: () => Promise<void>;
}

/** Verifies that the inherited Docker CLI context can reach its daemon. */
export async function preflightHostDocker(): Promise<void> {
	await promisify(execFile)("docker", ["info"], { env: process.env });
}

interface LocalWorkerUnitState {
	ref: WorkerUnitRef;
	child: ChildProcess;
	status: "running" | "stopping" | "exited";
}

let localUnitCounter = 0;

function nextUnitId(instanceId: string, workerId: string): string {
	localUnitCounter += 1;
	return `local_${instanceId}_${workerId}_${localUnitCounter}`;
}

function findServerPackageDir(): string {
	let current = path.dirname(fileURLToPath(import.meta.url));
	while (true) {
		const candidate = path.join(current, "package.json");
		if (existsSync(candidate)) return current;
		const parent = path.dirname(current);
		if (parent === current) return process.cwd();
		current = parent;
	}
}

function resolveDefaultWorkerEntryPath(): string {
	return fileURLToPath(import.meta.resolve(DEFAULT_LOCAL_WORKER_ENTRY_SPECIFIER));
}

export function resolveLocalWorkerSpawnArgs(args: readonly string[]): string[] {
	return args[0] === DEFAULT_LOCAL_WORKER_ENTRY_SPECIFIER
		? [resolveDefaultWorkerEntryPath(), ...args.slice(1)]
		: [...args];
}

function exitInfo(code: number | null, signal: NodeJS.Signals | null): WorkerExitInfo {
	return { exitCode: code, signal };
}

/**
 * Best-effort local development/test {@link WorkerRunner}.
 *
 * This runner implements the shared runner contract needed to start and stop a
 * local worker over the production WebSocket IPC path. It is not an isolation
 * boundary, has no restart adoption, and ignores image/resource profile semantics.
 * Docker and Kubernetes remain the contract-defining production runners.
 */
export function createLocalWorkerRunner(options: LocalWorkerRunnerOptions): {
	runner: WorkerRunner<LocalStartWorkerInput>;
	exporter: ProcessStateExporter;
} {
	const command = options.command ?? "node";
	const args = resolveLocalWorkerSpawnArgs(options.args ?? [DEFAULT_LOCAL_WORKER_ENTRY_SPECIFIER]);
	const cwd = options.cwd ?? findServerPackageDir();
	const localWorkerSpawnImpl = options.localWorkerSpawnImpl ?? spawn;
	const dockerPreflightImpl = options.dockerPreflightImpl ?? preflightHostDocker;
	const units = new Map<string, LocalWorkerUnitState>();
	const exitNotifier = new UnitExitNotifier();

	function wrap(ref: WorkerUnitRef): WorkerUnit {
		return exitNotifier.wrapUnit(ref, ref.unitId);
	}

	const runner: WorkerRunner<LocalStartWorkerInput> = {
		async start(input: LocalStartWorkerInput, observer): Promise<WorkerUnit> {
			observer?.report("preparing_runtime");
			if (input.docker) {
				if (options.allowHostDocker !== true) {
					throw new Error("Docker-requiring processes need local_worker.allow_host_docker: true");
				}
				try {
					await dockerPreflightImpl();
				} catch (error) {
					throw new Error("Local Docker preflight failed: Docker CLI or daemon is unavailable", {
						cause: error,
					});
				}
			}
			const unitId = nextUnitId(input.instanceId, input.workerId);
			const ref: WorkerUnitRef = { instanceId: input.instanceId, workerId: input.workerId, unitId };
			observer?.report("starting_runtime");
			const child = localWorkerSpawnImpl(command, args, {
				cwd,
				stdio: ["ignore", "inherit", "inherit"],
				env: { ...process.env, ...input.env },
			});
			const state: LocalWorkerUnitState = {
				ref,
				child,
				status: "running",
			};
			units.set(unitId, state);
			child.once("exit", (code, signal) => {
				state.status = "exited";
				exitNotifier.fireExit(unitId, exitInfo(code, signal));
			});
			child.once("error", (error) => {
				state.status = "exited";
				exitNotifier.fireExit(unitId, {
					exitCode: null,
					signal: null,
					reason: error instanceof Error ? error.message : String(error),
				});
			});
			return wrap(ref);
		},
		async stop(ref: WorkerUnitRef, opts: StopWorkerOptions): Promise<void> {
			const state = units.get(ref.unitId);
			if (!state || state.status === "exited") return;
			state.status = "stopping";
			const child = state.child;
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			child.kill("SIGTERM");
			const timedOut = await Promise.race([
				exited.then(() => false),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(true), opts.graceMs)),
			]);
			if (timedOut) child.kill("SIGKILL");
		},
		async list(): Promise<WorkerUnitDescriptor[]> {
			return [];
		},
		async adopt(descriptor: WorkerUnitDescriptor): Promise<WorkerUnit> {
			throw new Error(
				`Cannot adopt local worker ${descriptor.unitId}: local runner does not support adoption`,
			);
		},
	};

	const processWorkspacesDir = path.resolve(
		options.processWorkspacesDir ?? "/tmp/leitwerk/workspaces",
	);
	const treeFilesDir = path.resolve(options.treeFilesDir ?? "/tmp/leitwerk/trees");
	const exporter = createFilesystemProcessStateExporter({
		allowedRoots: [processWorkspacesDir, treeFilesDir],
		resolveSource: (instanceId) => ({
			workspaceRoot: path.join(processWorkspacesDir, instanceId),
			sessionFile: path.join(treeFilesDir, `${instanceId}.jsonl`),
		}),
	});
	return { runner, exporter };
}

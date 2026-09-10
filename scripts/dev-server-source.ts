import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import chokidar from "chokidar";
import { loadDevContext } from "./dev-context.ts";
import {
	createCoalescedRunner,
	observeUnexpectedChildFailure,
	spawnTsx,
	stopManaged,
	stopManagedForExit,
	waitForSuccess,
} from "./dev-process.ts";
import { loadActiveDevelopmentComposition } from "./development-composition.ts";

const repoRoot = process.cwd();
const coreRuntimePackages = [
	"domain",
	"extension-runtime",
	"external-writes",
	"process-sdk",
	"protocol",
	"server",
	"watcher-utils",
	"worker",
	"worker-protocol",
	"worker-runners",
];

function ignoredRuntimePath(candidate: string): boolean {
	const normalized = candidate.split(path.sep).join("/");
	return (
		/(^|\/)tests?(\/|$)/.test(normalized) ||
		/(^|\/)test-fixtures?(\/|$)/.test(normalized) ||
		/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
		/\/src\/ui\//.test(normalized) ||
		/\/dist\//.test(normalized)
	);
}

function debounceMs(): number {
	const parsed = Number.parseInt(process.env.LEITWERK_DEV_RELOAD_DEBOUNCE_MS ?? "", 10);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : 200;
}

async function waitForBackendReady(child: ChildProcess, startedAt: number): Promise<boolean> {
	const baseUrl = process.env.LEITWERK_BASE_URL ?? "http://127.0.0.1:8080";
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
		try {
			const response = await fetch(new URL("/api/health", baseUrl));
			if (response.ok) {
				console.info(
					`[dev:server] Backend ready pid=${child.pid} after ${Date.now() - startedAt}ms.`,
				);
				return true;
			}
		} catch {
			// The single-writer handoff is still in progress.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return child.exitCode !== null || child.signalCode !== null;
}

function runPreflight(env: NodeJS.ProcessEnv): Promise<boolean> {
	return waitForSuccess(
		spawnTsx(env.LEITWERK_DEV_PREFLIGHT_ENTRY ?? "scripts/dev-preflight.ts", {
			cwd: repoRoot,
			env,
			stdio: "inherit",
		}),
	);
}

async function main(): Promise<void> {
	process.env.LEITWERK_RUNTIME_LANE = "source";
	const context = await loadDevContext();
	const env: NodeJS.ProcessEnv = {
		...process.env,
		LEITWERK_RUNTIME_LANE: "source",
		LEITWERK_LOCAL_WORKER_COMMAND: process.env.LEITWERK_LOCAL_WORKER_COMMAND ?? process.execPath,
		LEITWERK_LOCAL_WORKER_ARGS_JSON:
			process.env.LEITWERK_LOCAL_WORKER_ARGS_JSON ??
			JSON.stringify(["--conditions=source", "--import", "tsx", "../worker/src/worker-entry.ts"]),
	};

	const backendEntry = process.env.LEITWERK_DEV_BACKEND_ENTRY
		? path.resolve(process.env.LEITWERK_DEV_BACKEND_ENTRY)
		: path.join(repoRoot, "packages/server/src/main.ts");
	const watchPaths = new Set<string>([backendEntry]);
	const extraWatchPaths: unknown = JSON.parse(process.env.LEITWERK_DEV_WATCH_PATHS_JSON ?? "[]");
	if (
		!Array.isArray(extraWatchPaths) ||
		!extraWatchPaths.every((value) => typeof value === "string")
	)
		throw new Error("LEITWERK_DEV_WATCH_PATHS_JSON must be an array of paths");
	for (const watchPath of extraWatchPaths) watchPaths.add(path.resolve(watchPath));
	for (const packageName of coreRuntimePackages) {
		watchPaths.add(path.join(repoRoot, "packages", packageName, "src"));
	}
	for (const extension of context.extensions) {
		const srcDir = path.join(extension.packageDir, "src");
		watchPaths.add(existsSync(srcDir) ? srcDir : extension.entryPath);
	}
	for (const packageInfo of loadActiveDevelopmentComposition(repoRoot)?.externalPackages ?? []) {
		const srcDir = path.join(packageInfo.dir, "src");
		if (existsSync(srcDir)) watchPaths.add(srcDir);
	}
	let backend: ChildProcess | null = null;
	let shuttingDown = false;
	let timer: NodeJS.Timeout | null = null;
	let watcher: chokidar.FSWatcher | null = null;
	const changedPaths = new Set<string>();
	const expectedBackendExits = new WeakSet<ChildProcess>();

	const shutdown = async (exitCode: number): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		if (timer) clearTimeout(timer);
		await watcher?.close();
		if (backend) {
			expectedBackendExits.add(backend);
			await stopManagedForExit(backend, exitCode, 20_000, 1_000);
		}
		process.exit(exitCode);
	};

	const spawnBackend = (): ChildProcess => {
		const startedAt = Date.now();
		const child = spawnTsx(backendEntry, {
			cwd: repoRoot,
			env,
			stdio: "inherit",
		});
		console.info(
			`[dev:server] Started source backend pid=${child.pid} (${Date.now() - startedAt}ms spawn).`,
		);
		void waitForBackendReady(child, startedAt).then((readyOrExited) => {
			if (
				!readyOrExited &&
				!shuttingDown &&
				backend === child &&
				!expectedBackendExits.has(child)
			) {
				console.error(
					`[dev:server] Backend pid=${child.pid} did not become ready within 30s; stopping the development session.`,
				);
				void shutdown(1);
			}
		});
		observeUnexpectedChildFailure(
			child,
			() => shuttingDown || expectedBackendExits.has(child),
			({ code, signal, error }) => {
				const reason = error?.message ?? signal ?? `code ${String(code)}`;
				console.error(
					`[dev:server] Backend failed unexpectedly (${reason}); stopping the development session.`,
				);
				void shutdown(1);
			},
		);
		return child;
	};

	const restart = createCoalescedRunner(
		async () => {
			const paths = [...changedPaths];
			changedPaths.clear();
			console.info(
				`[dev:server] Preflighting ${paths.length} changed runtime path(s): ${paths
					.slice(0, 5)
					.map((candidate) => path.relative(repoRoot, candidate))
					.join(", ")}${paths.length > 5 ? ", …" : ""}`,
			);
			if (!(await runPreflight(env))) {
				console.error("[dev:server] Preflight failed; keeping the current backend running.");
				return;
			}
			if (shuttingDown) return;
			const previous = backend;
			backend = null;
			if (previous) {
				expectedBackendExits.add(previous);
				await stopManaged(previous, { graceMs: 20_000 });
			}
			if (!shuttingDown) backend = spawnBackend();
		},
		() => shuttingDown,
	);

	backend = spawnBackend();
	watcher = chokidar.watch([...watchPaths], {
		ignoreInitial: true,
		ignored: (candidate: string) => ignoredRuntimePath(candidate),
		awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
	});
	watcher.on("all", (_event, changedPath) => {
		if (shuttingDown) return;
		changedPaths.add(path.resolve(changedPath));
		if (timer) clearTimeout(timer);
		timer = setTimeout(restart.run, debounceMs());
	});
	watcher.on("ready", () => {
		console.info(
			`[dev:server] Watching source runtime (${coreRuntimePackages.length} core packages, ${context.extensions.length} active extensions); tests and extension UI are excluded.`,
		);
	});
	watcher.on("error", (error) => console.error("[dev:server] Watch error", error));

	process.once("SIGINT", () => void shutdown(130));
	process.once("SIGTERM", () => void shutdown(143));
}

void main().catch((error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : error);
	process.exit(1);
});

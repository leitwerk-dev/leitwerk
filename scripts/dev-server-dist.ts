import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import chokidar from "chokidar";
import { forwardChildLifecycle } from "./dev-process.ts";
import { loadActiveDevelopmentComposition } from "./development-composition.ts";
import { workspacePackages } from "./workspace-packages.ts";

function listRuntimeDistWatchPaths(workspaceRoot: string): string[] {
	const watchPaths = new Set<string>();
	const composition = loadActiveDevelopmentComposition(workspaceRoot);
	for (const packageInfo of [
		...workspacePackages(workspaceRoot),
		...(composition?.externalPackages ?? []),
	]) {
		if (packageInfo.name === "@leitwerk-dev/ui") continue;
		const distDir = path.join(packageInfo.dir, "dist");
		if (!existsSync(distDir)) continue;
		if (
			typeof packageInfo.scripts?.["dev:ext-ui"] === "string" &&
			existsSync(path.join(distDir, "ui"))
		) {
			for (const distEntry of readdirSync(distDir, { withFileTypes: true })) {
				if (distEntry.name !== "ui") watchPaths.add(path.join(distDir, distEntry.name));
			}
			continue;
		}
		watchPaths.add(distDir);
	}
	for (const configPath of [
		path.join(workspaceRoot, "leitwerk.yaml"),
		path.join(workspaceRoot, "leitwerk.yaml.example"),
		...(composition ? [composition.runtimeConfigPath, composition.manifestPath] : []),
	]) {
		if (existsSync(configPath)) {
			watchPaths.add(configPath);
		}
	}

	return [...watchPaths].sort((left, right) => left.localeCompare(right));
}

function positiveIntEnv(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// The running server only loads JavaScript (and reads the YAML config). TypeScript
// declaration files and sourcemaps are build-time artifacts the process never
// imports, yet tsup emits them into the watched dist dirs — the `.d.ts` tail in
// particular lags the `.js` output by many seconds under load. Restarting on them
// is pure noise, so they are excluded from the watch entirely.
function isIgnoredWatchPath(candidate: string, stats?: { isFile(): boolean }): boolean {
	if (!stats?.isFile()) return false;
	const normalized = candidate.split(path.sep).join("/");
	if (/\.(?:test|spec)\.js$/.test(normalized)) return true;
	return !candidate.endsWith(".js") && !candidate.endsWith(".yaml") && !candidate.endsWith(".yml");
}

async function main(): Promise<void> {
	const workspaceRoot = process.cwd();
	const watchPaths = listRuntimeDistWatchPaths(workspaceRoot);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		LEITWERK_RUNTIME_LANE: "dist",
		LEITWERK_LOCAL_WORKER_COMMAND: process.env.LEITWERK_LOCAL_WORKER_COMMAND ?? "node",
		LEITWERK_LOCAL_WORKER_ARGS_JSON:
			process.env.LEITWERK_LOCAL_WORKER_ARGS_JSON ??
			JSON.stringify(["../worker/dist/worker-entry.js"]),
	};

	// Chokidar detects dist changes; node --watch restarts only when we touch an
	// external sentinel. Turbo prebuilt dist, so the server can boot immediately.
	// Warmup swallows the tsup startup storm until a quiet window or hard cap;
	// live mode debounces stable writes into one sentinel touch per rebuild.
	// The quiet window must exceed the storm's internal gaps (~2.5s).
	const stabilityThresholdMs = positiveIntEnv(process.env.LEITWERK_DEV_STABILITY_MS, 400);
	const debounceMs = positiveIntEnv(process.env.LEITWERK_DEV_RELOAD_DEBOUNCE_MS, 1200);
	const warmupQuietMs = positiveIntEnv(process.env.LEITWERK_DEV_WARMUP_QUIET_MS, 4000);
	const maxWarmupMs = positiveIntEnv(process.env.LEITWERK_DEV_WARMUP_MAX_MS, 30_000);

	// The sentinel lives outside any watched dist directory so touching it can
	// never be observed by chokidar (which would otherwise be a feedback loop).
	const sentinelDir = path.join(tmpdir(), "leitwerk-dev-server-watch");
	mkdirSync(sentinelDir, { recursive: true });
	const sentinelPath = path.join(sentinelDir, `restart-${process.pid}.signal`);
	rmSync(sentinelPath, { force: true });
	writeFileSync(sentinelPath, "");

	console.info(
		`[dev:server:dist] Watching runtime builds via chokidar (${watchPaths.length} paths, warmup-quiet ${warmupQuietMs}ms, stability ${stabilityThresholdMs}ms, debounce ${debounceMs}ms); restart sentinel: ${sentinelPath}`,
	);

	const child = spawn(
		process.execPath,
		[
			"--watch",
			"--watch-path",
			sentinelPath,
			"--watch-preserve-output",
			path.join(workspaceRoot, "packages/server/dist/main.js"),
		],
		{
			cwd: workspaceRoot,
			env,
			stdio: "inherit",
		},
	);

	const watcher = chokidar.watch(watchPaths, {
		ignoreInitial: true,
		ignored: (candidate: string, stats) => isIgnoredWatchPath(candidate, stats),
		awaitWriteFinish: {
			stabilityThreshold: stabilityThresholdMs,
			pollInterval: Math.min(100, stabilityThresholdMs),
		},
	});

	let phase: "warmup" | "live" = "warmup";
	let warmupQuietTimer: NodeJS.Timeout | undefined;
	let warmupCapTimer: NodeJS.Timeout | undefined;
	let debounceTimer: NodeJS.Timeout | undefined;
	let shuttingDown = false;

	const enterLive = (): void => {
		if (phase === "live" || shuttingDown) {
			return;
		}
		phase = "live";
		clearTimeout(warmupQuietTimer);
		warmupQuietTimer = undefined;
		clearTimeout(warmupCapTimer);
		warmupCapTimer = undefined;
		console.info("[dev:server:dist] Build outputs settled; live reload armed.");
	};

	const touchSentinel = (): void => {
		const now = new Date();
		try {
			utimesSync(sentinelPath, now, now);
		} catch (error) {
			console.error(
				`[dev:server:dist] Failed to touch restart sentinel: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	};

	const onChange = (): void => {
		if (shuttingDown) {
			return;
		}
		if (phase === "warmup") {
			// Swallow the startup storm: never restart, just keep pushing the quiet
			// timer out until writes stop.
			clearTimeout(warmupQuietTimer);
			warmupQuietTimer = setTimeout(enterLive, warmupQuietMs);
			return;
		}
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(touchSentinel, debounceMs);
	};

	watcher.on("all", () => onChange());
	watcher.on("ready", () => {
		// Arm only the cap: "ready" can precede tsup's first write by seconds.
		// Start the quiet timer on the first change to avoid ending warmup early.
		// The cap also ends warmup when no rebuild occurs.
		warmupCapTimer = setTimeout(enterLive, maxWarmupMs);
	});
	watcher.on("error", (error) => {
		console.error(
			`[dev:server:dist] Watch error: ${error instanceof Error ? error.message : String(error)}`,
		);
	});

	const cleanup = (): void => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		clearTimeout(warmupQuietTimer);
		clearTimeout(warmupCapTimer);
		clearTimeout(debounceTimer);
		void watcher.close();
		rmSync(sentinelPath, { force: true });
	};

	forwardChildLifecycle(child, cleanup);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});

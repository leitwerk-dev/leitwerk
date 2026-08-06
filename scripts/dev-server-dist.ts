import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import chokidar from "chokidar";

interface RootPackageJson {
	workspaces?: unknown;
}

interface WorkspacePackageJson {
	name?: unknown;
	scripts?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson<T>(filePath: string): T {
	return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function listWorkspacePatterns(workspaces: unknown): string[] {
	if (Array.isArray(workspaces)) {
		return workspaces.filter((value): value is string => typeof value === "string");
	}
	if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
		return workspaces.packages.filter((value): value is string => typeof value === "string");
	}
	return [];
}

function hasScript(scripts: unknown, scriptName: string): boolean {
	return isRecord(scripts) && typeof scripts[scriptName] === "string";
}

function expandWorkspacePattern(workspaceRoot: string, pattern: string): string[] {
	if (pattern.endsWith("/*")) {
		const baseDir = path.join(workspaceRoot, pattern.slice(0, -2));
		if (!existsSync(baseDir)) {
			return [];
		}
		return readdirSync(baseDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(baseDir, entry.name))
			.filter((packageDir) => existsSync(path.join(packageDir, "package.json")));
	}

	const packageDir = path.join(workspaceRoot, pattern);
	return existsSync(path.join(packageDir, "package.json")) ? [packageDir] : [];
}

function listRuntimeDistWatchPaths(workspaceRoot: string): string[] {
	const rootPackageJson = readJson<RootPackageJson>(path.join(workspaceRoot, "package.json"));
	const watchPaths = new Set<string>();

	for (const pattern of listWorkspacePatterns(rootPackageJson.workspaces)) {
		for (const workspaceDir of expandWorkspacePattern(workspaceRoot, pattern)) {
			const packageJson = readJson<WorkspacePackageJson>(path.join(workspaceDir, "package.json"));
			if (packageJson.name === "@leitwerk-dev/ui") {
				continue;
			}
			const distDir = path.join(workspaceDir, "dist");
			if (!existsSync(distDir)) {
				continue;
			}

			if (hasScript(packageJson.scripts, "dev:ext-ui") && existsSync(path.join(distDir, "ui"))) {
				for (const distEntry of readdirSync(distDir, { withFileTypes: true })) {
					if (distEntry.name !== "ui") {
						watchPaths.add(path.join(distDir, distEntry.name));
					}
				}
				continue;
			}

			watchPaths.add(distDir);
		}
	}

	for (const configPath of [
		path.join(workspaceRoot, "leitwerk.yaml"),
		path.join(workspaceRoot, "leitwerk.yaml.example"),
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

	// Restart strategy. `node --watch` pointed at the dist tree restarts on every
	// raw filesystem event, so a single multi-file rebuild — and its staggered
	// `.d.ts` tail — produces a cascade of restarts. Worse, at dev startup the
	// ~17 tsup watchers each re-emit their (already turbo-built) dist, a multi-
	// second storm with internal gaps of ~2.5s. So responsibilities are split:
	//
	//   chokidar     → all change detection over the dist tree
	//   sentinel     → a single file outside the watched tree
	//   node --watch → process restart lifecycle, watching ONLY the sentinel
	//
	// The server boots immediately. Booting during the startup storm is safe: the
	// dist is already valid (turbo built it before the watchers spawned), and once
	// a module is imported, later rewrites of that file do not affect the running
	// process — only a restart would, and we control restarts via the sentinel.
	//
	// chokidar runs a small state machine:
	//   warmup → swallow the startup storm. The sentinel is never touched. A quiet
	//            timer (reset on every change) ends warmup once writes have been
	//            silent for `warmupQuietMs`; a hard cap bounds the worst case.
	//   live   → each change debounces a single sentinel touch, and `awaitWriteFinish`
	//            reports each file only once it stops growing, so a real edit yields
	//            exactly one graceful restart.
	//
	// `warmupQuietMs` must exceed the storm's internal gaps (one-time, latency is
	// irrelevant). `debounceMs` only needs to coalesce a single rebuild's writes,
	// so it stays short for snappy reloads. Both, plus the file-stability window,
	// are overridable.
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
	let warmupQuietTimer: NodeJS.Timeout | null = null;
	let warmupCapTimer: NodeJS.Timeout | null = null;
	let debounceTimer: NodeJS.Timeout | null = null;
	let shuttingDown = false;

	const enterLive = (): void => {
		if (phase === "live" || shuttingDown) {
			return;
		}
		phase = "live";
		if (warmupQuietTimer) {
			clearTimeout(warmupQuietTimer);
			warmupQuietTimer = null;
		}
		if (warmupCapTimer) {
			clearTimeout(warmupCapTimer);
			warmupCapTimer = null;
		}
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
			if (warmupQuietTimer) {
				clearTimeout(warmupQuietTimer);
			}
			warmupQuietTimer = setTimeout(enterLive, warmupQuietMs);
			return;
		}
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(touchSentinel, debounceMs);
	};

	watcher.on("all", () => onChange());
	watcher.on("ready", () => {
		// Arm ONLY the cap here. Arming the quiet timer at "ready" races the storm's
		// start: chokidar scans the watched paths and emits "ready" within ~1s, but
		// the tsup watchers (spawned in parallel) take a few seconds to emit their
		// first rebuild. A quiet timer armed at "ready" would fire in that gap
		// before the storm begins, ending warmup early and letting the storm through
		// as "live" restarts. Instead the quiet timer is armed on the FIRST observed
		// change (see onChange), so warmup cannot end until the storm has both
		// started and gone quiet. The cap bounds the case where nothing ever
		// rebuilds (already-warm dist) so live reload still arms eventually.
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
		if (warmupQuietTimer) {
			clearTimeout(warmupQuietTimer);
		}
		if (warmupCapTimer) {
			clearTimeout(warmupCapTimer);
		}
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		void watcher.close();
		rmSync(sentinelPath, { force: true });
	};

	process.once("SIGINT", () => {
		cleanup();
		child.kill("SIGINT");
	});
	process.once("SIGTERM", () => {
		cleanup();
		child.kill("SIGTERM");
	});

	child.once("error", (error) => {
		cleanup();
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
	child.once("exit", (code, signal) => {
		cleanup();
		if (signal === "SIGINT") {
			process.exit(130);
			return;
		}
		if (signal === "SIGTERM") {
			process.exit(143);
			return;
		}
		process.exit(code ?? 1);
	});
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});

import type { ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";
import chokidar from "chokidar";
import { type DevContext, loadDevContext } from "./dev-context.ts";
import {
	createCoalescedRunner,
	spawnAttachedTsx,
	spawnTsx,
	stopAttached,
	stopAttachedForExit,
	stopManaged,
	waitForSuccess,
} from "./dev-process.ts";

const repoRoot = process.cwd();

function spawnSession(): ChildProcess {
	return spawnAttachedTsx(path.join(repoRoot, "scripts/dev.ts"), {
		cwd: repoRoot,
		env: process.env,
		stdio: "inherit",
	});
}

function devInputPaths(context: DevContext): Set<string> {
	const paths = new Set<string>();
	if (context.configPath !== "<defaults>") paths.add(context.configPath);
	for (const extension of context.extensions) {
		paths.add(path.join(extension.packageDir, "package.json"));
		if (extension.uiSource) paths.add(extension.uiSource.manifestPath);
	}
	return paths;
}

async function main(): Promise<void> {
	process.env.LEITWERK_RUNTIME_LANE = "source";
	const initialContext = await loadDevContext();
	let session: ChildProcess;
	const validationChildren = new Set<ChildProcess>();
	let shuttingDown = false;

	const observeSession = (child: ChildProcess): void => {
		child.once("error", () => void shutdown(1));
		child.once("exit", (code, signal) => {
			if (shuttingDown || child !== session || restart.isRunning()) return;
			void shutdown(code ?? (signal === "SIGINT" ? 130 : 1));
		});
	};
	const startSession = (): ChildProcess => {
		const child = spawnSession();
		session = child;
		observeSession(child);
		return child;
	};
	session = startSession();

	let watchedInputPaths = devInputPaths(initialContext);
	const watcher =
		watchedInputPaths.size === 0
			? null
			: chokidar.watch([...watchedInputPaths], {
					ignoreInitial: true,
					awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
				});

	const runPreflight = async (): Promise<DevContext | null> => {
		try {
			const candidateContext = await loadDevContext();
			const child = spawnTsx(path.join(repoRoot, "scripts/dev-preflight.ts"), {
				cwd: repoRoot,
				env: process.env,
				stdio: "inherit",
			});
			validationChildren.add(child);
			const valid = await waitForSuccess(child).finally(() => validationChildren.delete(child));
			return valid ? candidateContext : null;
		} catch (error) {
			console.error(error instanceof Error ? (error.stack ?? error.message) : error);
			return null;
		}
	};

	const updateWatchedInputs = async (context: DevContext): Promise<void> => {
		if (!watcher) return;
		const nextPaths = devInputPaths(context);
		const removed = [...watchedInputPaths].filter((candidate) => !nextPaths.has(candidate));
		const added = [...nextPaths].filter((candidate) => !watchedInputPaths.has(candidate));
		if (removed.length > 0) await watcher.unwatch(removed);
		if (added.length > 0) watcher.add(added);
		watchedInputPaths = nextPaths;
	};

	const restart = createCoalescedRunner(
		async () => {
			console.info(
				"[dev] Configuration or extension metadata changed; validating before restarting the development session.",
			);
			const candidateContext = await runPreflight();
			if (!candidateContext) {
				console.error("[dev] Development preflight failed; keeping the current session running.");
				return;
			}
			if (shuttingDown) return;
			await stopAttached(session, { graceMs: 27_000 });
			await updateWatchedInputs(candidateContext);
			if (!shuttingDown) startSession();
		},
		() => shuttingDown,
	);

	watcher?.on("all", restart.run);
	watcher?.on("error", (error) => console.error("[dev] Input watch error", error));

	const shutdown = async (exitCode: number): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		await watcher?.close();
		await Promise.all(
			[...validationChildren].map((child) => stopManaged(child, { graceMs: 10_000 })),
		);
		// Ctrl+C is an operator-requested stop, not a live-reload handoff. Keep
		// enough time for nested supervisors to close, then force the dev tree.
		await stopAttachedForExit(session, exitCode, 27_000, 3_000);
		process.exit(exitCode);
	};

	process.once("SIGINT", () => void shutdown(130));
	process.once("SIGTERM", () => void shutdown(143));
}

void main().catch((error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : error);
	process.exit(1);
});

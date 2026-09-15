import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@leitwerk-dev/server";
import chokidar, { type FSWatcher } from "chokidar";
import { createServer, type ViteDevServer } from "vite";
import { loadWorkspaceComposition } from "./composition.js";
import { build } from "./development.js";
import { compositionPath, type DevelopmentOptions, workspaceRoot } from "./selection.js";
import { packageDirectory, workspacePackages } from "./workspace.js";

export async function develop(options: DevelopmentOptions): Promise<void> {
	const root = workspaceRoot(options);
	const manifestPath = compositionPath(options);
	const uiRoot = path.join(packageDirectory("@leitwerk-dev/ui", root), "dist");
	if (!existsSync(path.join(uiRoot, "index.html")))
		throw new Error("Installed Leitwerk UI has no dist/index.html");
	let backend: ChildProcess | undefined;
	let expectedExit: ChildProcess | undefined;
	let ui: ViteDevServer | undefined;
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopping = false;
	let restarting = false;
	let pending = false;
	const settings = () => {
		const input = loadWorkspaceComposition(manifestPath);
		const configPath = process.env.LEITWERK_CONFIG_PATH ?? input.runtimeConfigPath;
		const loaded = loadConfig(configPath);
		if (!loaded.ok) throw new Error(loaded.error);
		const host = process.env.HOST ?? loaded.config.server.host;
		const port = Number(process.env.PORT ?? loaded.config.server.port);
		const uiPort = Number(process.env.LEITWERK_UI_PORT ?? 5173);
		if (![port, uiPort].every((value) => Number.isInteger(value) && value > 0 && value <= 65535))
			throw new Error("Development ports must be integers from 1 to 65535");
		if (port === uiPort) throw new Error("Backend and UI ports must differ");
		const proxyHost = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
		return {
			input,
			configPath,
			host,
			port,
			uiPort,
			baseUrl: loaded.config.server.base_url,
			backendUrl: `http://${proxyHost.includes(":") ? `[${proxyHost}]` : proxyHost}:${port}`,
		};
	};
	async function stopBackend() {
		const child = backend;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		expectedExit = child;
		const exit = once(child, "exit");
		child.kill("SIGTERM");
		const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000);
		await exit;
		clearTimeout(timeout);
	}
	async function shutdown(code: number) {
		if (stopping) return;
		stopping = true;
		clearTimeout(timer);
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", terminate);
		await watcher?.close();
		await stopBackend();
		await ui?.close();
		process.exitCode = code;
	}
	const interrupt = () => void shutdown(130);
	const terminate = () => void shutdown(143);
	async function start(input: ReturnType<typeof settings>) {
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL("./server.js", import.meta.url))],
			{
				cwd: root,
				stdio: "inherit",
				env: {
					...process.env,
					LEITWERK_RUNTIME_LANE: "dist",
					LEITWERK_COMPOSITION_PATH: manifestPath,
					LEITWERK_CONFIG_PATH: input.configPath,
					HOST: input.host,
					PORT: String(input.port),
					LEITWERK_BASE_URL: process.env.LEITWERK_BASE_URL ?? input.baseUrl,
				},
			},
		);
		backend = child;
		child.once("error", (error) => {
			console.error(error.message);
			void shutdown(1);
		});
		child.once("exit", () => {
			if (!stopping && expectedExit !== child) void shutdown(1);
		});
		const deadline = Date.now() + 30_000;
		let ready = false;
		while (
			!stopping &&
			child.exitCode === null &&
			child.signalCode === null &&
			Date.now() < deadline
		) {
			try {
				if (
					(await fetch(`${input.backendUrl}/api/ready`, { signal: AbortSignal.timeout(1000) })).ok
				) {
					ready = true;
					break;
				}
			} catch {
				/* Server is starting. */
			}
			await delay(100);
		}
		if (!ready) throw new Error(`Backend did not become ready at ${input.backendUrl}`);
		ui = await createServer({
			configFile: false,
			root: uiRoot,
			cacheDir: path.join(root, ".leitwerk", "vite"),
			server: {
				host: "127.0.0.1",
				port: input.uiPort,
				strictPort: true,
				proxy: {
					"/api": input.backendUrl,
					"/ext-ui": input.backendUrl,
					"/ws": { target: input.backendUrl, ws: true },
				},
			},
		});
		await ui.listen();
		ui.printUrls();
		await watcher?.add([
			input.configPath,
			...workspacePackages(root).flatMap((entry) => [
				path.join(entry.dir, "src"),
				path.join(entry.dir, "package.json"),
			]),
		]);
	}
	async function restart() {
		pending = true;
		if (restarting || stopping) return;
		restarting = true;
		try {
			while (pending && !stopping) {
				pending = false;
				let input: ReturnType<typeof settings>;
				try {
					input = settings();
					await build(root);
				} catch (error) {
					console.error(error instanceof Error ? error.message : "Build failed");
					continue;
				}
				if (stopping) break;
				await stopBackend();
				await ui?.close();
				if (stopping) break;
				await start(input);
			}
		} catch (error) {
			console.error(error instanceof Error ? error.message : "Restart failed");
			await shutdown(1);
		} finally {
			restarting = false;
		}
	}
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", terminate);
	try {
		const input = settings();
		await build(root);
		watcher = chokidar.watch(
			[
				manifestPath,
				input.configPath,
				path.join(root, "package.json"),
				...workspacePackages(root).flatMap((entry) => [
					path.join(entry.dir, "src"),
					path.join(entry.dir, "package.json"),
				]),
			],
			{
				ignoreInitial: true,
				ignored: /(?:^|\/)node_modules\/|\.(?:test|spec)\.[cm]?[jt]s$/,
				awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
			},
		);
		watcher.on("all", () => {
			clearTimeout(timer);
			timer = setTimeout(() => void restart(), 200);
		});
		watcher.on("error", (error) => {
			console.error(error instanceof Error ? error.message : "Source watcher failed");
			void shutdown(1);
		});
		await start(input);
		console.info("Watching extensions against installed Leitwerk packages.");
	} catch (error) {
		await shutdown(1);
		throw error;
	}
}

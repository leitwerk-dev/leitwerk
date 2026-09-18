import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { prepareSandboxDirectory, sandboxConfig } from "./config.js";
import type { SandboxCompositionFactory, SandboxInput } from "./index.js";
import { assertSandboxPath, processIdentity, resetSandbox, sandboxDirectory } from "./storage.js";

/** @public */
export interface SandboxLauncherOptions {
	/** @public */
	publicRoot: string;
	/** @public */
	workspaceRoot: string;
	/** @public */
	compositionEntry: string;
	/** @internal */
	args?: string[];
}

/** Only these ambient values enter the sandbox process tree. @public */
export function sandboxEnvironment(
	directory: string,
	ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return {
		PATH: path.dirname(process.execPath) + path.delimiter + (ambient.PATH ?? ""),
		HOME: directory,
		TMPDIR: ambient.TMPDIR,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ALLOW_PROTOCOL: "file",
		GIT_AUTHOR_NAME: "Sandbox Developer",
		GIT_AUTHOR_EMAIL: "developer@sandbox.invalid",
		GIT_COMMITTER_NAME: "Sandbox Developer",
		GIT_COMMITTER_EMAIL: "developer@sandbox.invalid",
	};
}
function port(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
		throw new Error("Sandbox ports must be integers between 1 and 65535");
	return Number(value);
}

/** @public */
export async function launchSandbox(options: SandboxLauncherOptions): Promise<void> {
	const workspaceRoot = realpathSync(options.workspaceRoot);
	const root = sandboxDirectory(workspaceRoot);
	const args = options.args ?? process.argv.slice(2);
	if (args.length === 1 && args[0] === "reset") {
		await resetSandbox(workspaceRoot);
		console.info("Reset local sandbox storage.");
		return;
	}
	if (args.some((arg) => !/^(--llm=(scripted|real)|--ui-port=\d+|--backend-port=\d+)$/.test(arg)))
		throw new Error(
			"Usage: dev:sandbox [--llm=scripted|real] [--ui-port=5173] [--backend-port=18082]",
		);
	const mode = args.includes("--llm=real") ? "real" : "scripted";
	const uiPort = port(args.find((arg) => arg.startsWith("--ui-port="))?.split("=")[1], 5173);
	const backendPort = port(
		args.find((arg) => arg.startsWith("--backend-port="))?.split("=")[1],
		18082,
	);
	if (uiPort === backendPort) throw new Error("UI and backend ports must differ");
	const input: SandboxInput = {
		paths: { workspaceRoot, root, directory: path.join(root, mode) },
		mode,
		urls: { ui: `http://127.0.0.1:${uiPort}`, backend: `http://127.0.0.1:${backendPort}` },
		modelProfileId: "sandbox",
	};
	prepareSandboxDirectory(input);
	const pidFile = path.join(input.paths.directory, "supervisor.pid");
	assertSandboxPath(root, pidFile);
	if (existsSync(pidFile))
		throw new Error(`Sandbox is already running or its pid file is stale: ${pidFile}`);
	const config = sandboxConfig(input);
	input.modelProfileId = config.pi.model_profiles[0].id;
	const factory: SandboxCompositionFactory = (
		await import(pathToFileURL(options.compositionEntry).href)
	).default;
	const composition = factory(input);
	config.process_configs = composition.processConfigs;
	const configPath = path.join(input.paths.directory, "leitwerk.yaml");
	const compositionPath = path.join(input.paths.directory, "composition.yaml");
	for (const [file, contents] of [
		[configPath, config],
		[
			compositionPath,
			{
				version: 1,
				workspace_root: workspaceRoot,
				runtime_config: configPath,
				extensions: composition.development.extensions,
				test_roots: [],
			},
		],
	] as const) {
		assertSandboxPath(root, file);
		writeFileSync(file, stringify(contents), { mode: 0o600 });
		chmodSync(file, 0o600);
	}
	await composition.cleanup?.();
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	const entry = (name: string) => fileURLToPath(new URL(`./${name}.${extension}`, import.meta.url));
	const env: NodeJS.ProcessEnv = {
		...sandboxEnvironment(input.paths.directory),
		LEITWERK_COMPOSITION_PATH: compositionPath,
		LEITWERK_CONFIG_PATH: configPath,
		LEITWERK_SANDBOX_INPUT: JSON.stringify(input),
		LEITWERK_SANDBOX_COMPOSITION_ENTRY: options.compositionEntry,
		LEITWERK_DEV_PREFLIGHT_ENTRY: entry("preflight"),
		LEITWERK_DEV_BACKEND_ENTRY: entry("backend"),
		LEITWERK_DEV_WATCH_PATHS_JSON: JSON.stringify([
			...composition.development.watchPaths,
			fileURLToPath(new URL(".", import.meta.url)),
		]),
		LEITWERK_DEV_STRICT_PORT: "1",
		LEITWERK_UI_HOST: "127.0.0.1",
		LEITWERK_UI_PORT: String(uiPort),
	};
	const owner = { pid: process.pid, identity: processIdentity(process.pid) };
	writeFileSync(pidFile, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
	console.info(`Local controls: ${input.urls.backend}/__local`);
	try {
		await runSupervisor(options.publicRoot, env);
	} catch (error) {
		// A dead supervisor does not prove that its detached children stopped.
		writeFileSync(pidFile, JSON.stringify({ ...owner, shutdownFailed: true }), { mode: 0o600 });
		throw error;
	}
	rmSync(pidFile, { force: true });
}

async function runSupervisor(publicRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
	const child = spawn(
		process.execPath,
		["--conditions=source", "--import", "tsx", "scripts/dev-supervisor.ts"],
		{ cwd: publicRoot, env, stdio: "inherit", detached: true },
	);
	let timer: NodeJS.Timeout | undefined;
	const signal = (value: NodeJS.Signals) => {
		try {
			if (child.pid) process.kill(-child.pid, value);
		} catch {
			/* Already stopped. */
		}
	};
	const stop = () => {
		signal("SIGTERM");
		timer ??= setTimeout(() => signal("SIGKILL"), 35_000);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		const [code, exitSignal] = await once(child, "exit");
		if (code !== 0 && code !== 130 && code !== 143)
			throw new Error(`Sandbox supervisor stopped (${exitSignal ?? code})`);
	} finally {
		clearTimeout(timer);
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}

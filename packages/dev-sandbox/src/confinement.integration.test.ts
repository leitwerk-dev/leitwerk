import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { getDefaultConfig } from "@leitwerk-dev/server";
import { StubPiTreeHandleFactory } from "@leitwerk-dev/test-support/worker-testing";
import { expect, onTestFinished, test } from "vitest";
import { sandboxConfig } from "./config.js";
import type { SandboxCompositionFactory, SandboxInput } from "./index.js";
import { sandboxEnvironment } from "./launcher.js";
import { preflightSandbox } from "./preflight.js";
import { processIdentity, resetSandbox, sandboxDirectory } from "./storage.js";

const root = () => {
	const directory = mkdtempSync(path.join(tmpdir(), "sandbox-contract-"));
	onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
};

test("excludes ambient provider, Pi, Git and Node overrides", () => {
	const env = sandboxEnvironment("/local/session", {
		PATH: "/bin",
		TMPDIR: "/tmp",
		GITHUB_TOKEN: "secret",
		ANTHROPIC_API_KEY: "secret",
		PI_CODING_AGENT_DIR: "/ambient",
		NODE_OPTIONS: "--import malicious",
		GIT_CONFIG_COUNT: "1",
		SSH_AUTH_SOCK: "/agent",
	});
	expect(env).toMatchObject({
		HOME: "/local/session",
		TMPDIR: "/tmp",
		GIT_ALLOW_PROTOCOL: "file",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "Sandbox Developer",
		GIT_AUTHOR_EMAIL: "developer@sandbox.invalid",
		GIT_COMMITTER_NAME: "Sandbox Developer",
		GIT_COMMITTER_EMAIL: "developer@sandbox.invalid",
	});
	expect(env.PATH?.split(path.delimiter)).toEqual(
		expect.arrayContaining([path.dirname(process.execPath), "/bin"]),
	);
	for (const name of [
		"GITHUB_TOKEN",
		"ANTHROPIC_API_KEY",
		"PI_CODING_AGENT_DIR",
		"NODE_OPTIONS",
		"GIT_CONFIG_COUNT",
		"SSH_AUTH_SOCK",
	])
		expect(env[name]).toBeUndefined();
});

test("preflight initializes and cleans adapters only in disposable storage", async () => {
	const directory = root();
	const config = getDefaultConfig();
	const input: SandboxInput = {
		paths: { root: directory, directory, workspaceRoot: directory },
		urls: { backend: "http://127.0.0.1:18082", ui: "http://127.0.0.1:5173" },
		mode: "scripted",
		modelProfileId: "sandbox",
	};
	config.server.host = "127.0.0.1";
	config.server.base_url = input.urls.backend;
	writeFileSync(path.join(directory, "providers.json"), "retained");
	let candidateRoot = "";
	let cleaned = false;
	const factory: SandboxCompositionFactory = ({ paths }) => ({
		processConfigs: {},
		development: { extensions: [], watchPaths: [] },
		scenarios: [],
		initialize() {
			candidateRoot = paths.directory;
			writeFileSync(path.join(paths.directory, "providers.json"), "candidate");
		},
		createCatalog: () => buildExtensionCatalogFromModules([]),
		scriptedPi: () => new StubPiTreeHandleFactory(),
		cleanup() {
			cleaned = true;
		},
	});
	await preflightSandbox(config, input, factory);
	expect(readFileSync(path.join(directory, "providers.json"), "utf8")).toBe("retained");
	expect(candidateRoot).not.toBe("");
	expect(candidateRoot).not.toBe(directory);
	expect(existsSync(candidateRoot)).toBe(false);
	expect(cleaned).toBe(true);
});

test("reset refuses a reused PID without removing either session", async () => {
	const directory = root();
	const sandbox = sandboxDirectory(directory);
	for (const mode of ["scripted", "real"]) {
		mkdirSync(path.join(sandbox, mode));
		writeFileSync(path.join(sandbox, mode, "owned"), `${mode} state`);
	}
	writeFileSync(
		path.join(sandbox, "real", "supervisor.pid"),
		JSON.stringify({ pid: process.pid, identity: "another process" }),
	);
	await expect(resetSandbox(directory)).rejects.toThrow(/PID was reused/);
	for (const mode of ["scripted", "real"]) {
		expect(readFileSync(path.join(sandbox, mode, "owned"), "utf8")).toBe(`${mode} state`);
	}
});

test("reset retains state when its supervisor does not acknowledge shutdown", async () => {
	const directory = root();
	const sandbox = sandboxDirectory(directory);
	const child = spawn(process.execPath, [
		"-e",
		"process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
	]);
	try {
		await once(child.stdout, "data");
		if (!child.pid) throw new Error("Missing child PID");
		for (const mode of ["scripted", "real"]) {
			mkdirSync(path.join(sandbox, mode));
			writeFileSync(path.join(sandbox, mode, "owned"), `${mode} state`);
		}
		writeFileSync(
			path.join(sandbox, "scripted", "supervisor.pid"),
			JSON.stringify({ pid: child.pid, identity: processIdentity(child.pid) }),
		);
		await expect(resetSandbox(directory, { shutdownTimeoutMs: 100 })).rejects.toThrow(
			/did not stop/,
		);
		expect(existsSync(path.join(sandbox, "scripted", "supervisor.pid"))).toBe(true);
		for (const mode of ["scripted", "real"]) {
			expect(readFileSync(path.join(sandbox, mode, "owned"), "utf8")).toBe(`${mode} state`);
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
	}
});

test("reset retains both sessions after an unconfirmed supervisor exit", async () => {
	const directory = root();
	const sandbox = sandboxDirectory(directory);
	for (const mode of ["scripted", "real"]) {
		mkdirSync(path.join(sandbox, mode));
		writeFileSync(path.join(sandbox, mode, "owned"), `${mode} state`);
	}
	writeFileSync(
		path.join(sandbox, "scripted", "supervisor.pid"),
		JSON.stringify({
			pid: process.pid,
			identity: "unconfirmed supervisor",
			shutdownFailed: true,
		}),
	);
	await expect(resetSandbox(directory)).rejects.toThrow(/shutdown was not confirmed/);
	for (const mode of ["scripted", "real"]) {
		expect(readFileSync(path.join(sandbox, mode, "owned"), "utf8")).toBe(`${mode} state`);
	}
});

test("real mode requires a dedicated mode-0600 credential file and rejects symlinks", () => {
	const directory = root();
	const input: SandboxInput = {
		paths: { root: directory, directory: path.join(directory, "real"), workspaceRoot: directory },
		urls: { backend: "http://127.0.0.1:18082", ui: "http://127.0.0.1:5173" },
		mode: "real",
		modelProfileId: "sandbox-real",
	};
	const file = path.join(directory, "model.json");
	expect(() => sandboxConfig(input)).toThrow(/dedicated/);
	writeFileSync(
		file,
		JSON.stringify({
			model_profiles: [
				{ id: "sandbox-real", provider: "test", model_id: "test", thinking_level: "off" },
			],
			providers: { test: { api_key: "synthetic-dedicated-key" } },
		}),
	);
	chmodSync(file, 0o644);
	expect(() => sandboxConfig(input)).toThrow(/0600/);
	chmodSync(file, 0o600);
	const configured = sandboxConfig(input);
	expect(configured.pi.model_profiles).toEqual([
		{ id: "sandbox-real", provider: "test", model_id: "test", thinking_level: "off" },
	]);
	expect(configured.extensions.models).toEqual({
		test: { api_key: "synthetic-dedicated-key" },
	});
	rmSync(file);
	const outside = path.join(directory, "outside.json");
	writeFileSync(outside, "{}", { mode: 0o600 });
	symlinkSync(outside, file);
	expect(() => sandboxConfig(input)).toThrow(/symlink/);
});

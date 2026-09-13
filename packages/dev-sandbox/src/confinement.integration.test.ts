import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { getDefaultConfig } from "@leitwerk-dev/server";
import { StubPiTreeHandleFactory } from "@leitwerk-dev/test-support/worker-testing";
import { afterEach, expect, test } from "vitest";
import type { SandboxCompositionFactory, SandboxInput } from "./index.js";
import { sandboxEnvironment } from "./launcher.js";
import { preflightSandbox } from "./preflight.js";
import { processIdentity, resetSandbox, sandboxDirectory } from "./storage.js";

const roots: string[] = [];
const root = () => {
	const directory = mkdtempSync(path.join(tmpdir(), "sandbox-contract-"));
	roots.push(directory);
	return directory;
};
afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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
	expect(env).toEqual(
		expect.objectContaining({ HOME: "/local/session", GIT_ALLOW_PROTOCOL: "file" }),
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
	expect(candidateRoot).not.toBe(directory);
	expect(existsSync(candidateRoot)).toBe(false);
	expect(cleaned).toBe(true);
});

test("reset refuses a reused PID without removing either session", async () => {
	const directory = root();
	const sandbox = sandboxDirectory(directory);
	mkdirSync(path.join(sandbox, "real"));
	mkdirSync(path.join(sandbox, "scripted"));
	writeFileSync(
		path.join(sandbox, "real", "supervisor.pid"),
		JSON.stringify({ pid: process.pid, identity: "another process" }),
	);
	await expect(resetSandbox(directory)).rejects.toThrow(/PID was reused/);
	expect(existsSync(path.join(sandbox, "scripted"))).toBe(true);
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
		mkdirSync(path.join(sandbox, "scripted"));
		writeFileSync(
			path.join(sandbox, "scripted", "supervisor.pid"),
			JSON.stringify({ pid: child.pid, identity: processIdentity(child.pid) }),
		);
		await expect(resetSandbox(directory, { shutdownTimeoutMs: 100 })).rejects.toThrow(
			/did not stop/,
		);
		expect(existsSync(path.join(sandbox, "scripted", "supervisor.pid"))).toBe(true);
	} finally {
		child.kill("SIGKILL");
		await once(child, "exit");
	}
});

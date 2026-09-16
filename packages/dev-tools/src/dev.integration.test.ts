import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { testWorkspace } from "../test-workspace.js";
import { stopAttached } from "./child-process.js";

async function unusedPort(): Promise<number> {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing TCP address");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

async function fixture() {
	const { root, json } = testWorkspace();
	const publicRoot = fileURLToPath(new URL("../../../", import.meta.url));
	const [backendPort, uiPort] = await Promise.all([unusedPort(), unusedPort()]);
	mkdirSync(path.join(root, "extension/src"), { recursive: true });
	symlinkSync(path.join(publicRoot, "node_modules"), path.join(root, "node_modules"), "dir");
	json("package.json", { private: true, type: "module", workspaces: ["extension"] });
	writeFileSync(
		path.join(root, "leitwerk.composition.yaml"),
		"version: 1\nruntime_config: ./leitwerk.yaml\nextensions: [./extension]\n",
	);
	writeFileSync(
		path.join(root, "leitwerk.yaml"),
		`server:\n  host: 127.0.0.1\n  port: ${backendPort}\n  base_url: http://127.0.0.1:${uiPort}\nstorage:\n  sqlite_path: .leitwerk/test.sqlite\n  process_workspaces_dir: .leitwerk/workspaces\n  tree_files_dir: .leitwerk/trees\nworkers:\n  runner: local\npi:\n  agent_dir: .leitwerk/pi\n`,
	);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
		HOST: "127.0.0.1",
		PORT: String(backendPort),
		LEITWERK_UI_PORT: String(uiPort),
	};
	for (const key of [
		"LEITWERK_CONFIG_PATH",
		"LEITWERK_COMPOSITION_PATH",
		"LEITWERK_BASE_URL",
		"NODE_OPTIONS",
	])
		delete env[key];
	function start(detached = false) {
		const child = spawn(
			process.execPath,
			[path.join(publicRoot, "packages/dev-tools/dist/cli.js"), "dev"],
			{ cwd: root, env, detached, stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "";
		for (const stream of [child.stdout, child.stderr])
			stream.on("data", (data) => {
				output += data;
			});
		const waitFor = (predicate: () => boolean | Promise<boolean>, timeout = 15_000) =>
			vi.waitFor(
				async () => {
					expect(child.exitCode, output).toBeNull();
					expect(await predicate(), output).toBeTruthy();
				},
				{ timeout, interval: 100 },
			);
		return { child, output: () => output, waitFor };
	}
	return { root, json, uiPort, env, start };
}

it("runs the installed CLI outside the core checkout, forwards the UI API and retains the backend through failed builds", async () => {
	const { root, json, uiPort, start } = await fixture();
	json("extension/package.json", {
		name: "@example/probe",
		version: "1.0.0",
		type: "module",
		scripts: { build: "node build.mjs" },
		leitwerk: { extension: { source: "./src/index.js", import: "./dist/index.js" } },
	});
	writeFileSync(
		path.join(root, "extension/build.mjs"),
		`import fs from 'node:fs'; if (fs.existsSync('block-build')) { console.error('BUILD_BLOCKED'); process.exit(1); } fs.mkdirSync('dist', {recursive:true}); fs.copyFileSync('src/index.js','dist/index.js');`,
	);
	const source = (version: number) =>
		`console.log('PROBE_${version}:'+process.pid); export default { manifest: { id: 'probe', version: '1.0.0' } };`;
	writeFileSync(path.join(root, "extension/src/index.js"), source(1));
	const { child, output, waitFor } = start();
	const ready = async () => {
		try {
			return (
				await fetch(`http://127.0.0.1:${uiPort}/api/ready`, { signal: AbortSignal.timeout(1000) })
			).ok;
		} catch {
			return false;
		}
	};
	try {
		await waitFor(ready);
		expect(output()).toContain("PROBE_1:");
		expect(await (await fetch(`http://127.0.0.1:${uiPort}/`)).text()).toContain("<html");
		const firstPid = /PROBE_1:(\d+)/.exec(output())?.[1];
		expect(firstPid).toBeDefined();
		writeFileSync(path.join(root, "extension/block-build"), "blocked");
		writeFileSync(path.join(root, "extension/src/index.js"), source(2));
		await waitFor(() => output().includes("BUILD_BLOCKED"));
		expect(await ready()).toBe(true);
		expect(output()).not.toContain("PROBE_2:");
		expect(() => process.kill(Number(firstPid), 0)).not.toThrow();
		rmSync(path.join(root, "extension/block-build"));
		writeFileSync(path.join(root, "extension/src/index.js"), source(3));
		await waitFor(async () => output().includes("PROBE_3:") && (await ready()));
		expect(/PROBE_3:(\d+)/.exec(output())?.[1]).not.toBe(firstPid);
	} finally {
		await stopAttached(child, { graceMs: 5000 });
	}
}, 45_000);

it("cancels an initial build that exits successfully without starting a backend afterward", async () => {
	const { root, json, env, start } = await fixture();
	mkdirSync(path.join(root, "bin"));
	json("extension/package.json", {
		name: "@example/cancel",
		type: "module",
		scripts: { build: "unused" },
		leitwerk: { extension: { source: "./index.js", import: "./index.js" } },
	});
	writeFileSync(
		path.join(root, "extension/index.js"),
		"console.log('UNEXPECTED_BACKEND'); export default { manifest: { id: 'cancel', version: '1.0.0' } };\n",
	);
	writeFileSync(
		path.join(root, "bin/npm"),
		`#!${process.execPath}\nprocess.once('SIGTERM', () => process.exit(0)); console.log('INITIAL_BUILD_READY'); setInterval(() => {}, 1000);\n`,
		{ mode: 0o700 },
	);
	env.PATH = `${path.join(root, "bin")}${path.delimiter}${env.PATH}`;
	const { child, output, waitFor } = start(true);
	try {
		await waitFor(() => output().includes("INITIAL_BUILD_READY"), 10_000);
		const exit = once(child, "exit");
		child.kill("SIGTERM");
		const timer = setTimeout(() => {
			if (child.pid) process.kill(-child.pid, "SIGKILL");
		}, 5000);
		try {
			await exit;
		} finally {
			clearTimeout(timer);
		}
		expect(child.exitCode, output()).toBe(143);
		expect(output()).not.toContain("UNEXPECTED_BACKEND");
	} finally {
		if (child.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				/* Owned process group has exited. */
			}
		}
	}
}, 20_000);

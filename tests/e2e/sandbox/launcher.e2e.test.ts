import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetSandbox } from "@leitwerk-dev/dev-sandbox/storage";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect, test } from "vitest";

async function reservePort() {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No port allocated");
	return {
		port: address.port,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

test("source supervisor uses strict ports, isolated reload preflight, and acknowledged reset", async () => {
	const workspace = mkdtempSync(path.join(tmpdir(), "sandbox-source-"));
	const source = fileURLToPath(new URL("../../../", import.meta.url));
	const directory = path.join(workspace, ".leitwerk/sandbox/scripted");
	writeFileSync(
		path.join(workspace, "package.json"),
		JSON.stringify({ private: true, workspaces: [] }),
	);
	const ui = await reservePort();
	const backend = await reservePort();
	await backend.close();
	const start = () => {
		let output = "";
		const child = spawn(
			process.execPath,
			[
				"--conditions=source",
				"--import",
				"tsx",
				"scripts/sandbox/cli.ts",
				`--ui-port=${ui.port}`,
				`--backend-port=${backend.port}`,
			],
			{
				cwd: source,
				env: {
					PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
					HOME: workspace,
					TMPDIR: tmpdir(),
					LEITWERK_SANDBOX_WORKSPACE_ROOT: workspace,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		return { child, output: () => output };
	};
	let running: ReturnType<typeof start> | undefined;
	try {
		running = start();
		await waitForValue(
			() => running?.child.exitCode,
			(code) => typeof code === "number",
			25000,
		);
		expect(running.child.exitCode, running.output()).not.toBe(0);
		expect(running.output()).toMatch(/already in use|EADDRINUSE/);
		await expect(resetSandbox(workspace)).rejects.toThrow(/shutdown was not confirmed/);
		await ui.close();
		// The failed fixture has exited; release its retained failure record for this test.
		rmSync(path.join(directory, "supervisor.pid"));
		running = start();
		const readyCount = () => running?.output().match(/Backend ready pid=/g)?.length ?? 0;
		await waitForValue(readyCount, (count) => count === 1, 30000);
		const url = `http://127.0.0.1:${backend.port}`;
		const response = await fetch(`${url}/__local/lost-response`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"enabled":true}',
		});
		expect(response.status).toBe(200);
		const stateFiles = ["tickets.json", "scenarios.json"].map((name) => path.join(directory, name));
		const before = stateFiles.map((file) => readFileSync(file, "utf8"));
		appendFileSync(path.join(directory, "leitwerk.yaml"), "\n# Exercise configuration reload.\n");
		await waitForValue(readyCount, (count) => count === 2, 45000);
		expect(running.output()).toContain("Configuration or extension metadata changed");
		expect(running.output()).not.toContain("preflight failed");
		expect(stateFiles.map((file) => readFileSync(file, "utf8"))).toEqual(before);
		const state = await (await fetch(`${url}/__local/state`)).json();
		expect(state).toMatchObject({
			uiUrl: `http://127.0.0.1:${ui.port}`,
			backendUrl: url,
			lostResponseEnabled: true,
		});
		expect(state.scenariosAvailable).toHaveLength(9);
		await resetSandbox(workspace);
		await waitForValue(
			() => running?.child.exitCode,
			(code) => code === 0,
			5000,
		);
		expect(existsSync(directory)).toBe(false);
	} finally {
		await ui.close();
		if (running && running.child.exitCode === null && running.child.signalCode === null) {
			running.child.kill("SIGTERM");
			await once(running.child, "exit");
		}
		rmSync(workspace, { recursive: true, force: true });
	}
}, 120000);

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSandboxApp, type SandboxInput } from "@leitwerk-dev/dev-sandbox";
import { getDefaultConfig } from "@leitwerk-dev/server";
import { postImmediateLaunch } from "@leitwerk-dev/test-support";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect } from "vitest";
import composition from "../../../sandbox/composition.js";
import { Notebook } from "../../../sandbox/notebook.js";

export async function waitForResponse<T>(
	read: () => Promise<T>,
	predicate: (value: T) => boolean,
	timeout = 12000,
): Promise<T> {
	const deadline = Date.now() + timeout;
	while (true) {
		const value = await read();
		if (predicate(value)) return value;
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for response: ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

export async function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "public-sandbox-test-"));
	const config = getDefaultConfig();
	config.server = { ...config.server, host: "127.0.0.1", base_url: "http://127.0.0.1:18082" };
	config.storage = {
		sqlite_path: path.join(root, "application.sqlite"),
		tree_files_dir: path.join(root, "trees"),
		process_workspaces_dir: path.join(root, "workspaces"),
	};
	config.pi.agent_dir = path.join(root, "pi-agent");
	config.workers.runner = "local";
	config.pi.model_profiles = [
		{ id: "sandbox", provider: "sandbox-model", model_id: "scripted", thinking_level: "off" },
	];
	config.pi.process_title_generation.model_profile = null;
	config.pi.retry.enabled = false;
	const input: SandboxInput = {
		paths: { workspaceRoot: root, root, directory: root },
		mode: "scripted",
		urls: { backend: config.server.base_url, ui: "http://127.0.0.1:19173" },
		modelProfileId: "sandbox",
	};
	config.process_configs = composition(input).processConfigs;
	let sandbox = await createSandboxApp(config, input, composition);
	let url: string;
	async function start() {
		await sandbox.context.app.listen({ host: "127.0.0.1", port: 0 });
		const address = sandbox.context.app.server.address();
		if (!address || typeof address === "string") throw new Error("No listening address");
		url = `http://127.0.0.1:${address.port}`;
		config.server.base_url = url;
		await sandbox.context.startBackgroundServices();
	}
	await start();
	return {
		root,
		input,
		config,
		get context() {
			return sandbox.context;
		},
		get notebook() {
			return new Notebook(root);
		},
		async restart() {
			await sandbox.stop();
			input.urls.backend = config.server.base_url;
			sandbox = await createSandboxApp(config, input, composition);
			await start();
		},
		async close() {
			await sandbox.stop();
			rmSync(root, { recursive: true, force: true });
		},
		async launch(name: string) {
			const response = await postImmediateLaunch(url, `sandbox.${name}`, { launcherInput: {} });
			const body = (await response.json()) as { process: { id: string } };
			expect(response.status, JSON.stringify(body)).toBe(201);
			return body.process.id;
		},
		async wait(id: string, turn: string | null, lifecycle = "waiting", timeout = 12000) {
			return waitForValue(
				() => {
					const p = sandbox.context.deps.processes.getById(id);
					if (p?.lifecycleStatus === "error" && lifecycle !== "error")
						throw new Error(JSON.stringify(sandbox.context.deps.turnRecords.listByInstance(id)));
					return p;
				},
				(p) => p?.selectedTurnId === turn && p.lifecycleStatus === lifecycle,
				timeout,
			);
		},
		async action(id: string, action: string, input: Record<string, unknown> = {}) {
			const response = await sandbox.context.app.inject({
				method: "POST",
				url: `/api/processes/${id}/actions/${action}`,
				payload: { input },
			});
			expect(response.statusCode, response.body).toBe(200);
		},
	};
}

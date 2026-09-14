import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSandboxApp, type SandboxInput, sandboxConfig } from "@leitwerk-dev/dev-sandbox";
import type { ProcessQuestionRequest } from "@leitwerk-dev/domain";
import { postImmediateLaunch } from "@leitwerk-dev/test-support";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { test as baseTest, expect, type TestContext } from "vitest";
import composition from "../../../sandbox/composition.js";
import { Notebook } from "../../../sandbox/notebook.js";

async function fixture(onTestFinished: TestContext["onTestFinished"]) {
	const root = mkdtempSync(path.join(tmpdir(), "public-sandbox-test-"));
	let sandbox: Awaited<ReturnType<typeof createSandboxApp>>;
	onTestFinished(async () => {
		try {
			await sandbox?.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	const input: SandboxInput = {
		paths: { workspaceRoot: root, root, directory: root },
		mode: "scripted",
		urls: { backend: "http://127.0.0.1:18082", ui: "http://127.0.0.1:19173" },
		modelProfileId: "sandbox",
	};
	const config = sandboxConfig(input);
	config.process_configs = composition(input).processConfigs;
	sandbox = await createSandboxApp(config, input, composition);
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
	async function post(url: string, payload: Record<string, unknown> = {}) {
		const response = await sandbox.context.app.inject({ method: "POST", url, payload });
		expect(response.statusCode, response.body).toBe(200);
		return response;
	}
	return {
		post,
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
		async question(id: string) {
			const question = await waitForValue(
				() => sandbox.context.deps.questionRequests.listOpen(id)[0],
				Boolean,
				12000,
			);
			if (!question) throw new Error("Missing question");
			return question;
		},
		answerFirstOption: (question: ProcessQuestionRequest) =>
			post(`/api/processes/${question.instanceId}/question-requests/${question.id}/answers`, {
				draft: [
					{ selectedOptionIds: [question.questions[0].options[0].id], freeText: "", comment: "" },
				],
			}),
		action: (id: string, action: string, input: Record<string, unknown> = {}) =>
			post(`/api/processes/${id}/actions/${action}`, { input }),
	};
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const test = baseTest.extend<{ f: Fixture }>({
	f: async ({ onTestFinished }, use) => use(await fixture(onTestFinished)),
});

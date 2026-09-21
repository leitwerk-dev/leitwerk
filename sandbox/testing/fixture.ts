import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createSandboxApp,
	type SandboxCompositionFactory,
	type SandboxInput,
	sandboxConfig,
} from "@leitwerk-dev/dev-sandbox";
import type { ProcessQuestionRequest } from "@leitwerk-dev/domain";
import { postImmediateLaunch } from "@leitwerk-dev/test-support";
import { createProcessDriver, waitForValue } from "@leitwerk-dev/test-support/integration";
import { test as baseTest, expect, type TestContext } from "vitest";
import composition from "../composition.js";
import { Notebook } from "../notebook.js";

export async function fixture(
	onTestFinished: TestContext["onTestFinished"],
	factory = composition,
) {
	const root = mkdtempSync(path.join(tmpdir(), "public-sandbox-test-"));
	let sandbox: Awaited<ReturnType<typeof createSandboxApp>>;
	onTestFinished(async () => {
		try {
			await sandbox?.stop();
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
	const input: SandboxInput = {
		paths: { workspaceRoot: root, root, directory: root },
		mode: "scripted",
		urls: { backend: "http://127.0.0.1:18082", ui: "http://127.0.0.1:19173" },
		modelProfileId: "sandbox",
	};
	const testFactory: SandboxCompositionFactory = (factoryInput) => {
		const composition = factory(factoryInput);
		return {
			...composition,
			scenarios: composition.scenarios.map((scenario) => {
				if (scenario.name === "startup")
					return { ...scenario, startupDelays: { connectMs: 70, prepareMs: 10 } };
				if (scenario.name === "startup-cold")
					return { ...scenario, startupDelays: { connectMs: 108, prepareMs: 10 } };
				return scenario;
			}),
		};
	};
	const config = sandboxConfig(input);
	config.process_configs = testFactory(input).processConfigs;
	sandbox = await createSandboxApp(config, input, testFactory);
	let url: string;
	async function start() {
		({ address: url } = await sandbox.context.listen({
			host: "127.0.0.1",
			port: 0,
			useBoundAddressAsBaseUrl: true,
		}));
	}
	await start();
	const driver = createProcessDriver(() => sandbox.context);
	return {
		...driver,
		root,
		input,
		config,
		get context() {
			return sandbox.context;
		},
		get notebook() {
			return new Notebook(root);
		},
		async restart(whileStopped?: () => Promise<void>) {
			await sandbox.stop();
			await whileStopped?.();
			input.urls.backend = config.server.base_url;
			sandbox = await createSandboxApp(config, input, testFactory);
			await start();
		},
		async launch(name: string, launcherInput: Record<string, unknown> = {}, production = false) {
			const response = await postImmediateLaunch(url, production ? name : `sandbox.${name}`, {
				launcherInput,
			});
			const body = (await response.json()) as { process: { id: string } };
			expect(response.status, JSON.stringify(body)).toBe(201);
			return body.process.id;
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
			driver.post(
				`/api/processes/${question.instanceId}/question-requests/${question.id}/answers`,
				{
					draft: [
						{ selectedOptionIds: [question.questions[0].options[0].id], freeText: "", comment: "" },
					],
				},
			),
	};
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const test = baseTest.extend<{ f: Fixture }>({
	f: async ({ onTestFinished }, use) => use(await fixture(onTestFinished)),
});

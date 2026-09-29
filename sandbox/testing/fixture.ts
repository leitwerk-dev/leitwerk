import type { SandboxCompositionFactory } from "@leitwerk-dev/dev-sandbox";
import { startSandboxHarness } from "@leitwerk-dev/dev-sandbox/testing";
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
	const sandbox = await startSandboxHarness(testFactory);
	onTestFinished(() => sandbox.stop());
	const driver = createProcessDriver(() => sandbox.context);
	return {
		...driver,
		root: sandbox.root,
		input: sandbox.input,
		config: sandbox.config,
		get context() {
			return sandbox.context;
		},
		get notebook() {
			return new Notebook(sandbox.root);
		},
		restart: sandbox.restart,
		async launch(name: string, launcherInput: Record<string, unknown> = {}, production = false) {
			const response = await postImmediateLaunch(
				sandbox.url,
				production ? name : `sandbox.${name}`,
				{
					launcherInput,
				},
			);
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

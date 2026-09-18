import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { defineProcess, emptyParamsCodec, llmTurn } from "@leitwerk-dev/process-sdk";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import {
	createPersistentIntegrationFixture,
	waitForValue,
} from "@leitwerk-dev/test-support/integration";
import {
	createInProcessWorkerSpawn,
	StubPiTreeHandleFactory,
	type StubToolCallScriptResolver,
} from "@leitwerk-dev/test-support/worker-testing";
import { expect, it, onTestFinished } from "vitest";

const prompt = "Retain this input sentinel across failed attempts.";
const turn = llmTurn<Record<string, never>, Record<string, never>>({
	description: "Session persistence",
	availableTools: [],
	completionMode: "turn_end",
	turnResultMarkdown: { mode: "assistant_output" },
	askQuestions: true,
	branchType: "primary",
	context: "fresh",
	prompt: async () => prompt,
	turnEnd: { outcome: "completed", params: {}, complete: true },
});
const processDefinition = defineProcess<Record<string, never>, Record<string, never>>({
	id: "session_test",
	displayName: "Session test",
	entry: "respond",
	turns: { respond: turn },
	paramsCodec: emptyParamsCodec,
	stateCodec: emptyParamsCodec,
	initialState: () => ({}),
	worker(proc) {
		proc.start("respond");
		proc.turn("respond", async (run) => {
			await run.turn(turn);
		});
	},
});

async function fixture(resolver: StubToolCallScriptResolver) {
	const persistent = createPersistentIntegrationFixture("leitwerk-session-migration-");
	onTestFinished(persistent.dispose);
	const config = persistent.createConfig();
	config.workers.shutdown_grace_period = "100ms";
	config.extension_loading.sources = [];
	config.pi.model_profiles = [
		{
			id: "session-model",
			provider: "session-provider",
			model_id: "fixture-model",
			thinking_level: "off",
		},
	];
	const catalog = await buildExtensionCatalogFromModules([
		{
			manifest: { id: "session-test", version: "0.1.0" },
			modelProviders: fixtureModelProviders({
				id: "session-provider",
				modelId: "fixture-model",
				piProvider: "ollama",
			}),
			setupCatalog(api) {
				api.registerProcess(processDefinition);
			},
		},
	]);
	const open = () =>
		persistent.open({
			config,
			extensionCatalog: catalog,
			appOverrides: {
				localWorkerSpawnImpl: createInProcessWorkerSpawn({
					extensionCatalog: catalog,
					piFactory: new StubPiTreeHandleFactory({
						recordSessionTrace: true,
						toolCallScriptResolver: resolver,
					}),
				}),
			},
		});
	const h = await open();
	await h.ctx.startBackgroundServices();
	const process = h.ctx.deps.processes.create({
		processId: processDefinition.id,
		lifecycleStatus: "discovered",
		selectedTurnId: null,
		defaultModelProfileId: "session-model",
	});
	expect((await h.ctx.deps.processEngine.startProcess(process.id, "respond")).ok).toBe(true);
	return {
		get ctx() {
			return persistent.context();
		},
		id: process.id,
		async restart() {
			await persistent.close();
			await open();
			await persistent.context().startBackgroundServices();
		},
		async wait(status: string) {
			await waitForValue(
				() => persistent.context().deps.processes.getById(process.id),
				(value) => value?.lifecycleStatus === status,
			);
		},
	};
}

it("retries a failed worker turn through HTTP without losing its input or failure record", async () => {
	let calls = 0;
	const f = await fixture(() => {
		if (++calls === 1) throw new Error("Scripted provider failure");
		return {
			calls: [],
			textChunks: ["Recovered result"],
			thinkingChunks: ["Retained retry reasoning"],
		};
	});
	await f.wait("error");
	expect(f.ctx.deps.processes.getById(f.id)?.selectedTurnId).toBe("respond");
	const [failed] = f.ctx.deps.turnRecords.listByInstance(f.id);
	expect(failed.status).toBe("failed");
	const reasoning = await f.ctx.app.inject(
		`/api/processes/${f.id}/turn-records/${failed.id}/reasoning`,
	);
	expect(reasoning.statusCode).toBe(200);
	expect(reasoning.json().reasoning.piInput.fullPrompt).toContain(prompt);
	const retried = await f.ctx.app.inject({ method: "POST", url: `/api/processes/${f.id}/retry` });
	expect(retried.statusCode, retried.body).toBe(200);
	await f.wait("completed");
	expect(calls).toBe(2);
	const records = f.ctx.deps.turnRecords.listByInstance(f.id);
	expect(records).toHaveLength(2);
	expect(records.find((record) => record.id === failed.id)?.status).toBe("failed");
	expect(records.filter((record) => record.status === "succeeded")).toHaveLength(1);
	await f.restart();
	expect(f.ctx.deps.turnRecords.listByInstance(f.id)).toEqual(records);
	const retained = await f.ctx.app.inject(
		`/api/processes/${f.id}/turn-records/${failed.id}/reasoning`,
	);
	expect(retained.statusCode).toBe(200);
	expect(retained.json().reasoning.piInput.fullPrompt).toContain(prompt);
});

it("retains long streamed output and thinking in session files and durable turn results after restart", async () => {
	const textChunks = Array.from(
		{ length: 80 },
		(_, i) => `Observation ${i + 1}: ${"evidence ".repeat(40)}\n`,
	);
	const f = await fixture(() => ({
		calls: [],
		textChunks,
		thinkingChunks: ["Preparing the synthetic response"],
		chunkDelayMs: 1,
	}));
	await f.wait("completed");
	const records = f.ctx.deps.turnRecords.listByInstance(f.id);
	expect(records).toHaveLength(1);
	expect(records[0].turnResultMarkdown?.length).toBeGreaterThan(20000);
	const response = await f.ctx.app.inject(`/api/processes/${f.id}/session`);
	expect(response.statusCode, response.body).toBe(200);
	expect(response.body).toContain("Observation 80");
	expect(response.body).toContain("Preparing the synthetic response");
	await f.restart();
	const restored = await f.ctx.app.inject(`/api/processes/${f.id}/session`);
	expect(restored.statusCode).toBe(200);
	expect(restored.body).toBe(response.body);
	expect(f.ctx.deps.turnRecords.listByInstance(f.id)).toEqual(records);
});

it("answers a worker question through HTTP and resumes the same turn", async () => {
	let toolResult: unknown;
	const f = await fixture(() => ({
		calls: [
			{
				toolName: "ask_questions",
				args: {
					questions: [
						{
							question: "Choose a strategy",
							selection: "single",
							options: [{ label: "Safe", details: "Small change" }],
						},
					],
				},
			},
		],
		afterToolResult(_call, result) {
			toolResult = result;
			return undefined;
		},
	}));
	const question = await waitForValue(() => f.ctx.deps.questionRequests.listOpen(f.id)[0], Boolean);
	if (!question) throw new Error("Missing worker question");
	const records = f.ctx.deps.turnRecords.listByInstance(f.id);
	expect(records).toHaveLength(1);
	expect(records[0]).toMatchObject({ id: question.turnRecordId, status: "running" });
	const answer = await f.ctx.app.inject({
		method: "POST",
		url: `/api/processes/${f.id}/question-requests/${question.id}/answers`,
		payload: {
			draft: [
				{ selectedOptionIds: [question.questions[0].options[0].id], freeText: "", comment: "" },
			],
		},
	});
	expect(answer.statusCode, answer.body).toBe(200);
	await f.wait("completed");
	expect(toolResult).toEqual({ answers: ["Safe"] });
	expect(f.ctx.deps.turnRecords.listByInstance(f.id)).toHaveLength(1);
	expect(f.ctx.deps.turnRecords.getById(question.turnRecordId)?.status).toBe("succeeded");
	expect(f.ctx.deps.questionRequests.getById(question.id)?.status).toBe("answered");
});

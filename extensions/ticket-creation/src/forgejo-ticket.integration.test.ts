import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupForgejoIntegration } from "@leitwerk-dev/forgejo";
import { LocalForgejoAdapter } from "@leitwerk-dev/forgejo/testing";
import { coreHostCapabilities, emptyParamsCodec, flow } from "@leitwerk-dev/process-sdk";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import { createExtensionIntegrationHarness } from "@leitwerk-dev/test-support/integration";
import { expect, it, onTestFinished } from "vitest";
import ticketCreation from "./index.js";

async function fixture(options: { clarifyDestination?: boolean } = {}) {
	const root = mkdtempSync(path.join(tmpdir(), "forgejo-ticket-adapter-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	let adapter: LocalForgejoAdapter;
	let changeInstructions: (id: string, prompt: string) => void = () => {
		throw new Error("Parent not initialized");
	};
	const parentDefinition = flow
		.process<{ prompt: string }, Record<string, never>>("ticket_test_parent")
		.displayName("Ticket test parent")
		.entry("retained_result")
		.codecs({
			params: {
				parse: (raw) => ({
					prompt: String(
						(raw as { prompt?: string } | undefined)?.prompt ?? "Original instructions",
					),
				}),
				serialize: (value) => value,
			},
			state: emptyParamsCodec,
		})
		.initialState(() => ({}))
		.turn(
			flow
				.llm<{ prompt: string }, Record<string, never>>("retained_result")
				.description("Retained result")
				.buildPrompt((ctx) => ctx.params.prompt)
				.publish("saved")
				.complete(),
		)
		.turn(
			flow
				.llm<{ prompt: string }, Record<string, never>>("new_parent_result")
				.description("New result")
				.buildPrompt((ctx) => ctx.params.prompt)
				.publish("saved")
				.complete(),
		)
		.server((api) =>
			api.action({
				id: "change_instructions",
				label: "Change instructions",
				executionMode: "side_effect",
				async execute(input, ctx) {
					changeInstructions(ctx.process.id, String(input.prompt));
				},
			}),
		)
		.define();
	const test = await createExtensionIntegrationHarness({
		extensions: [
			ticketCreation,
			{
				manifest: { id: "ticket-test-parent", version: "1" },
				setupCatalog(api) {
					api.registerProcess(parentDefinition);
				},
				setupServer(api) {
					const setup = api.require(coreHostCapabilities.serverSetup);
					changeInstructions = (id, prompt) => {
						setup.processes.update(id, { paramsJson: JSON.stringify({ prompt }) });
					};
				},
			},
			{
				manifest: { id: "forgejo", version: "1.0.0" },
				setupServer(api) {
					adapter = new LocalForgejoAdapter({
						root,
						baseUrl: "https://forgejo.example",
						seeds: [
							{ owner: "team", name: "service" },
							...(options.clarifyDestination ? [{ owner: "team", name: "workshop" }] : []),
						],
					});
					return setupForgejoIntegration(api, {
						profiles: () => ["local"],
						client: () => adapter.client(),
					});
				},
			},
			{
				manifest: { id: "ticket-model", version: "1.0.0" },
				modelProviders: fixtureModelProviders({
					id: "ticket-model",
					modelId: "scripted",
					server: true,
				}),
			},
		],
		models: [{ id: "scripted", provider: "ticket-model", modelId: "scripted" }],
		defaultModel: "scripted",
		script: () => ({
			tools: [
				...(options.clarifyDestination
					? [
							{
								name: "ask_questions",
								arguments: {
									questions: [
										{
											question: "Which repository should receive the ticket?",
											selection: "single",
											options: [{ label: "Service" }, { label: "Workshop" }],
										},
									],
								},
							},
						]
					: []),
				{
					name: "forgejo_create_issue",
					arguments: {
						destinationId: `local.${adapter.repo("team", "service").repository.id}`,
						title: "Review service",
						body: "Document the weekly review.",
					},
				},
			],
			afterToolResult(call, result) {
				if (
					result &&
					typeof result === "object" &&
					"code" in result &&
					result.code === "operator_feedback"
				)
					return {
						...call,
						arguments: {
							...call.arguments,
							body: `Document the weekly review.\n${"feedback" in result ? result.feedback : ""}`,
						},
					};
			},
		}),
	});
	onTestFinished(() => test.close());
	const parent = await test.createProcess(parentDefinition, {
		position: { selectedTurnId: null, lifecycleStatus: "completed" },
	});
	const retained = await parent.seedAcceptedTurn({
		turnId: "retained_result",
		execution: {
			status: "succeeded",
			outcome: "saved",
			markdown: "Review the service documentation.",
		},
	});
	function request(key: string) {
		return test.request({
			method: "POST",
			url: `/api/processes/${parent.id}/ticket-creation`,
			headers: { "idempotency-key": key },
			payload: {
				toolName: "forgejo_create_issue",
				artifact: retained.artifact,
				focus: { kind: "whole_result" },
			},
		});
	}
	return {
		test,
		parent,
		request,
		get adapter() {
			return adapter;
		},
		snapshot: (id: string) => test.process(id).snapshot(),
		async launch(key: string) {
			const response = await request(key);
			expect(response.statusCode, response.body).toBe(200);
			return response.json<{ childInstanceId: string }>().childInstanceId;
		},
		async approval(id: string) {
			const snapshot = await test
				.process(id)
				.waitFor((snapshot) => snapshot.approvals.some((request) => request.status === "open"));
			const approval = snapshot.approvals.find((request) => request.status === "open");
			if (!approval) throw new Error("Missing approval");
			return approval;
		},
		wait: (id: string, selectedTurnId: string | null, lifecycleStatus: string) =>
			test
				.process(id)
				.waitFor(
					(snapshot) =>
						snapshot.process.selectedTurnId === selectedTurnId &&
						snapshot.process.lifecycleStatus === lifecycleStatus,
				),
		restart: () => test.restart(),
	};
}

it("clarifies the destination, revises the draft through feedback, and declines without a write", async () => {
	const f = await fixture({ clarifyDestination: true });
	const id = await f.launch("feedback-ticket");
	const question = (
		await f.test
			.process(id)
			.waitFor((snapshot) => snapshot.questions.some((request) => request.status === "open"))
	).questions.find((request) => request.status === "open");
	if (!question) throw new Error("Missing destination question");
	expect(f.snapshot(id).approvals.filter((request) => request.status === "open")).toHaveLength(0);
	expect(f.snapshot(id).writeReceipts).toHaveLength(0);
	await f.test
		.process(id)
		.answerQuestions(question.id, [
			{ selectedOptionIds: [question.questions[0].options[0].id], freeText: "", comment: "" },
		]);
	const first = await f.approval(id);
	await f.test.process(id).respondToApproval(first.id, {
		action: "feedback",
		feedback: "Include a daily review schedule.",
	});
	const revised = await f.approval(id);
	expect(revised.id).not.toBe(first.id);
	expect(JSON.stringify(revised.arguments)).toContain("daily review schedule");
	expect(revised.destination).toMatchObject({ displayName: "team/service" });
	await f.test.process(id).respondToApproval(revised.id, { action: "decline" });
	await f.wait(id, null, "aborted");
	expect(f.snapshot(id).writeReceipts).toHaveLength(0);
	expect(f.adapter.repo("team", "service").issues).toHaveLength(0);
}, 15_000);

it("retries an interrupted approval, reconciles a lost response, and retains the child and receipt across restarts", async () => {
	const f = await fixture();
	const id = await f.launch("stable-ticket");
	const pending = await f.approval(id);
	const captured = (f.snapshot(id).params as { context: unknown }).context;
	await f.parent.action("change_instructions", { prompt: "Changed parent instructions" });
	await f.parent.seedAcceptedTurn({
		turnId: "new_parent_result",
		execution: {
			status: "succeeded",
			outcome: "saved",
			markdown: "A newer parent result must not replace the captured material.",
		},
	});
	expect((f.snapshot(id).params as { context: unknown }).context).toEqual(captured);
	await f.restart();
	expect(f.snapshot(id).approvals.some((request) => request.id === pending.id)).toBe(true);
	await f.wait(id, "create_ticket", "error");
	await f.test.process(id).retry();
	const retried = await f.approval(id);
	expect(retried.destination).toEqual(pending.destination);
	expect((f.snapshot(id).params as { context: unknown }).context).toEqual(captured);
	f.adapter.state.failAfterIssueWrite = true;
	f.adapter.save();
	await f.test.process(id).respondToApproval(retried.id, { action: "accept" });
	await f.wait(id, null, "completed");
	const issues = structuredClone(f.adapter.repo("team", "service").issues);
	expect(issues).toHaveLength(1);
	const writes = f.snapshot(id).writeReceipts;
	expect(writes.filter((write) => write.writeType === "forgejo.create_issue")).toHaveLength(1);
	await f.restart();
	const replay = await f.request("stable-ticket");
	expect(replay.statusCode, replay.body).toBe(200);
	expect(replay.json<{ childInstanceId: string }>().childInstanceId).toBe(id);
	expect(f.snapshot(id).process).toMatchObject({
		lifecycleStatus: "completed",
		externalId: `team/service#${issues[0].number}`,
	});
	expect(f.snapshot(id).writeReceipts).toEqual(writes);
	expect(f.adapter.repo("team", "service").issues).toEqual(issues);
}, 15_000);

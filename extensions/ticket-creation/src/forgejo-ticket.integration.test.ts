import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { setupForgejoIntegration } from "@leitwerk-dev/forgejo";
import { LocalForgejoAdapter } from "@leitwerk-dev/forgejo/testing";
import { createAcceptedLlmTurn } from "@leitwerk-dev/server/testing";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import {
	createPersistentIntegrationFixture,
	createProcessDriver,
	waitForValue,
} from "@leitwerk-dev/test-support/integration";
import { StubPiTreeHandleFactory } from "@leitwerk-dev/test-support/worker-testing";
import { expect, it, onTestFinished } from "vitest";
import ticketCreation from "./index.js";

async function fixture(options: { clarifyDestination?: boolean } = {}) {
	const persistent = createPersistentIntegrationFixture("forgejo-ticket-");
	onTestFinished(persistent.dispose);
	const { root, context } = persistent;
	let adapter: LocalForgejoAdapter;
	async function start() {
		adapter = new LocalForgejoAdapter({
			root,
			baseUrl: "https://forgejo.example",
			seeds: [
				{ owner: "team", name: "service" },
				...(options.clarifyDestination ? [{ owner: "team", name: "workshop" }] : []),
			],
		});
		const repository = adapter.repo("team", "service").repository;
		const catalog = await buildExtensionCatalogFromModules([
			ticketCreation,
			{
				manifest: { id: "forgejo", version: "1.0.0" },
				setupServer(api) {
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
		]);
		const piFactory = new StubPiTreeHandleFactory({
			toolCallScriptResolver: () => ({
				calls: [
					...(options.clarifyDestination
						? [
								{
									toolName: "ask_questions",
									args: {
										questions: [
											{
												id: "destination",
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
						toolName: "forgejo_create_issue",
						args: {
							destinationId: `local.${repository.id}`,
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
							args: {
								...call.args,
								body: `Document the weekly review.\n${"feedback" in result ? result.feedback : ""}`,
							},
						};
				},
			}),
		});
		await persistent.open({
			extensionCatalog: catalog,
			inProcessWorkers: { piFactory },
			configOverride(config) {
				config.pi.model_profiles = [
					{ id: "scripted", provider: "ticket-model", model_id: "scripted", thinking_level: "off" },
				];
				config.pi.process_title_generation.model_profile = "scripted";
				config.process_configs = {
					ticket_creation_process: { default_model_profile: "scripted", turn_configs: {} },
				};
			},
		});
	}
	await start();
	const driver = createProcessDriver(context);
	// A retained parent artifact is sufficient; no repository workflow or watcher is needed.
	const parent = context().deps.processes.create({
		processId: "ticket_creation_process",
		selectedTurnId: null,
		lifecycleStatus: "completed",
		paramsJson: "{}",
		stateJson: "{}",
	});
	const parentResult = createAcceptedLlmTurn(context(), {
		id: `${parent.id}_result`,
		turnType: "llm",
		instanceId: parent.id,
		turnId: "retained_result",
		status: "succeeded",
		turnResultMarkdown: "Review the service documentation.",
	});
	function request(key: string) {
		return context().app.inject({
			method: "POST",
			url: `/api/processes/${parent.id}/ticket-creation`,
			headers: { "idempotency-key": key },
			payload: {
				toolName: "forgejo_create_issue",
				artifact: { kind: "turn_result", turnRecordId: parentResult.id },
				focus: { kind: "whole_result" },
			},
		});
	}
	return {
		...driver,
		context,
		request,
		parentId: parent.id,
		get adapter() {
			return adapter;
		},
		async launch(key: string) {
			const response = await request(key);
			expect(response.statusCode, response.body).toBe(200);
			return response.json().childInstanceId as string;
		},
		async approval(id: string) {
			const pending = await waitForValue(
				() => context().deps.toolApprovalRequests.listOpen(id)[0],
				Boolean,
				12_000,
			);
			if (!pending) throw new Error("Missing approval");
			return pending;
		},
		async restart() {
			await persistent.close();
			await start();
		},
	};
}

it("clarifies the destination, revises the draft through feedback, and declines without a write", async () => {
	const f = await fixture({ clarifyDestination: true });
	const id = await f.launch("feedback-ticket");
	const question = await waitForValue(
		() => f.context().deps.questionRequests.listOpen(id)[0],
		Boolean,
		12_000,
	);
	if (!question) throw new Error("Missing destination question");
	expect(f.context().deps.toolApprovalRequests.listOpen(id)).toHaveLength(0);
	expect(f.context().deps.externalWrites.listByInstance(id)).toHaveLength(0);
	await f.post(`/api/processes/${id}/question-requests/${question.id}/answers`, {
		draft: [
			{ selectedOptionIds: [question.questions[0].options[0].id], freeText: "", comment: "" },
		],
	});
	const first = await f.approval(id);
	await f.post(`/api/processes/${id}/tool-approval-requests/${first.id}`, {
		action: "feedback",
		feedback: "Include a daily review schedule.",
	});
	const revised = await f.approval(id);
	expect(revised.id).not.toBe(first.id);
	expect(JSON.stringify(revised.arguments)).toContain("daily review schedule");
	expect(revised.destination).toMatchObject({ displayName: "team/service" });
	await f.post(`/api/processes/${id}/tool-approval-requests/${revised.id}`, { action: "decline" });
	await f.wait(id, null, "aborted");
	expect(f.context().deps.externalWrites.listByInstance(id)).toHaveLength(0);
	expect(f.adapter.repo("team", "service").issues).toHaveLength(0);
}, 15_000);

it("retries an interrupted approval, reconciles a lost response, and retains the child and receipt across restarts", async () => {
	const f = await fixture();
	const id = await f.launch("stable-ticket");
	const pending = await f.approval(id);
	const captured = JSON.parse(f.context().deps.processes.getById(id)?.paramsJson ?? "{}").context;
	f.context().deps.processes.update(f.parentId, {
		paramsJson: JSON.stringify({ prompt: "Changed parent instructions" }),
	});
	createAcceptedLlmTurn(f.context(), {
		id: `${f.parentId}_new_result`,
		turnType: "llm",
		instanceId: f.parentId,
		turnId: "new_parent_result",
		status: "succeeded",
		turnResultMarkdown: "A newer parent result must not replace the captured material.",
	});
	expect(JSON.parse(f.context().deps.processes.getById(id)?.paramsJson ?? "{}").context).toEqual(
		captured,
	);
	await f.restart();
	expect(
		f
			.context()
			.deps.toolApprovalRequests.listByInstance(id)
			.some((request) => request.id === pending.id),
	).toBe(true);
	await f.wait(id, "create_ticket", "error");
	await f.post(`/api/processes/${id}/retry`);
	const retried = await f.approval(id);
	expect(retried.destination).toEqual(pending.destination);
	expect(JSON.parse(f.context().deps.processes.getById(id)?.paramsJson ?? "{}").context).toEqual(
		captured,
	);
	f.adapter.state.failAfterIssueWrite = true;
	f.adapter.save();
	await f.post(`/api/processes/${id}/tool-approval-requests/${retried.id}`, { action: "accept" });
	await f.wait(id, null, "completed");
	const issues = structuredClone(f.adapter.repo("team", "service").issues);
	expect(issues).toHaveLength(1);
	const writes = f.context().deps.externalWrites.listByInstance(id);
	expect(writes.filter((write) => write.writeType === "forgejo.create_issue")).toHaveLength(1);
	await f.restart();
	const replay = await f.request("stable-ticket");
	expect(replay.statusCode, replay.body).toBe(200);
	expect(replay.json().childInstanceId).toBe(id);
	expect(f.context().deps.processes.getById(id)).toMatchObject({
		lifecycleStatus: "completed",
		externalId: `team/service#${issues[0].number}`,
	});
	expect(f.context().deps.externalWrites.listByInstance(id)).toEqual(writes);
	expect(f.adapter.repo("team", "service").issues).toEqual(issues);
}, 15_000);

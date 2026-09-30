import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupForgejoIntegration } from "@leitwerk-dev/forgejo";
import { LocalForgejoAdapter } from "@leitwerk-dev/forgejo/testing";
import { expect, it, onTestFinished } from "vitest";
import { createTicketFixture } from "./ticket-fixture.js";

async function fixture(options: { clarifyDestination?: boolean } = {}) {
	const root = mkdtempSync(path.join(tmpdir(), "forgejo-ticket-adapter-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	let adapter: LocalForgejoAdapter;
	const fixture = await createTicketFixture(
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
		"forgejo_create_issue",
		() => [
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
	);
	return {
		...fixture,
		get adapter() {
			return adapter;
		},
	};
}

it("clarifies the destination, revises the draft through feedback, and declines without a write", async () => {
	const f = await fixture({ clarifyDestination: true });
	const id = await f.launch("feedback-ticket");
	const child = f.test.process(id);
	const question = (
		await child.waitFor((snapshot) =>
			snapshot.questions.some((request) => request.status === "open"),
		)
	).questions.find((request) => request.status === "open");
	if (!question) throw new Error("Missing destination question");
	expect(child.snapshot().approvals.filter((request) => request.status === "open")).toHaveLength(0);
	expect(child.snapshot().writeReceipts).toHaveLength(0);
	await child.answerQuestions(question.id, [
		{ selectedOptionIds: [question.questions[0].options[0].id], freeText: "", comment: "" },
	]);
	const first = await f.approval(id);
	await child.respondToApproval(first.id, {
		action: "feedback",
		feedback: "Include a daily review schedule.",
	});
	const revised = await f.approval(id);
	expect(revised.id).not.toBe(first.id);
	expect(JSON.stringify(revised.arguments)).toContain("daily review schedule");
	expect(revised.destination).toMatchObject({ displayName: "team/service" });
	await child.respondToApproval(revised.id, { action: "decline" });
	await child.waitFor((snapshot) => snapshot.process.lifecycleStatus === "aborted");
	expect(child.snapshot().process.selectedTurnId).toBeNull();
	expect(child.snapshot().writeReceipts).toHaveLength(0);
	expect(f.adapter.repo("team", "service").issues).toHaveLength(0);
}, 15_000);

it("retries an interrupted approval, reconciles a lost response, and retains the child and receipt across restarts", async () => {
	const f = await fixture();
	const id = await f.launch("stable-ticket");
	const child = f.test.process(id);
	const pending = await f.approval(id);
	const captured = (child.snapshot().params as { context: unknown }).context;
	await f.parent.action("change_instructions", { prompt: "Changed parent instructions" });
	await f.parent.seedAcceptedTurn({
		turnId: "retained_result",
		execution: {
			status: "succeeded",
			outcome: "saved",
			markdown: "A newer parent result must not replace the captured material.",
		},
	});
	expect((child.snapshot().params as { context: unknown }).context).toEqual(captured);
	await f.test.restart();
	expect(child.snapshot().approvals.some((request) => request.id === pending.id)).toBe(true);
	await child.waitFor((snapshot) => snapshot.process.lifecycleStatus === "error");
	expect(child.snapshot().process.selectedTurnId).toBe("create_ticket");
	await child.retry();
	const retried = await f.approval(id);
	expect(retried.destination).toEqual(pending.destination);
	expect((child.snapshot().params as { context: unknown }).context).toEqual(captured);
	f.adapter.state.failAfterIssueWrite = true;
	f.adapter.save();
	await child.respondToApproval(retried.id, { action: "accept" });
	await child.waitFor((snapshot) => snapshot.process.lifecycleStatus === "completed");
	expect(child.snapshot().process.selectedTurnId).toBeNull();
	const issues = structuredClone(f.adapter.repo("team", "service").issues);
	expect(issues).toHaveLength(1);
	const writes = child.snapshot().writeReceipts;
	expect(writes.filter((write) => write.writeType === "forgejo.create_issue")).toHaveLength(1);
	await f.test.restart();
	const replay = await f.request("stable-ticket");
	expect(replay.statusCode, replay.body).toBe(200);
	expect(replay.json<{ childInstanceId: string }>().childInstanceId).toBe(id);
	expect(child.snapshot().process).toMatchObject({
		lifecycleStatus: "completed",
		externalId: `team/service#${issues[0].number}`,
	});
	expect(child.snapshot().writeReceipts).toEqual(writes);
	expect(f.adapter.repo("team", "service").issues).toEqual(issues);
}, 15_000);

import { readFileSync } from "node:fs";
import path from "node:path";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect } from "vitest";
import { type Fixture, test } from "./fixture.js";

async function draft(f: Fixture, instructions = "Create a notebook issue.") {
	const parent = await f.launch("ticket");
	await f.wait(parent, "plan_decision");
	const turn = f.context.deps.turnRecords
		.listByInstance(parent)
		.find((t) => t.turnId === "generate_plan");
	if (!turn) throw new Error("Missing parent result");
	const request = {
		method: "POST" as const,
		url: `/api/processes/${parent}/ticket-creation`,
		headers: { "idempotency-key": `ticket-${parent}` },
		payload: {
			toolName: "local_create_ticket",
			artifact: { kind: "turn_result", turnRecordId: turn.id },
			focus: { kind: "whole_result" },
			additionalInstructions: instructions,
		},
	};
	const response = await f.context.app.inject(request);
	expect(response.statusCode, response.body).toBe(200);
	return { id: response.json().childInstanceId as string, parent, request };
}
async function approval(f: Fixture, id: string) {
	return waitForValue(() => f.context.deps.toolApprovalRequests.listOpen(id)[0], Boolean, 12000);
}
async function decide(f: Fixture, id: string, action: string, feedback?: string) {
	const pending = await approval(f, id);
	if (!pending) throw new Error("Missing approval");
	await f.post(`/api/processes/${id}/tool-approval-requests/${pending.id}`, {
		action,
		...(feedback ? { feedback } : {}),
	});
	return pending;
}

test("restarts with an approval, reconciles a lost ticket response, and retains one durable receipt", async ({
	f,
}) => {
	const { id, parent, request } = await draft(f);
	const pending = await approval(f, id);
	expect(pending?.destination).toMatchObject({ id: "garden" });
	const captured = JSON.parse(f.context.deps.processes.getById(id)?.paramsJson ?? "{}").context;
	await f.action(parent, "request_revision", { message: "Revise the parent's plan." });
	await f.wait(parent, "plan_decision");
	expect(JSON.parse(f.context.deps.processes.getById(id)?.paramsJson ?? "{}").context).toEqual(
		captured,
	);
	await f.restart();
	// Ordinary local-worker shutdown parks the interrupted turn for Retry.
	expect(
		f.context.deps.toolApprovalRequests
			.listByInstance(id)
			.some((request) => request.id === pending?.id),
	).toBe(true);
	await f.wait(id, "create_ticket", "error");
	await f.post(`/api/processes/${id}/retry`);
	await approval(f, id);
	await f.post("/__local/lost-response", { enabled: true });
	await decide(f, id, "accept");
	await f.wait(id, null, "completed");
	const tickets = JSON.parse(readFileSync(path.join(f.root, "tickets.json"), "utf8")).tickets;
	expect(tickets).toHaveLength(1);
	expect(f.context.deps.externalWrites.listByInstance(id)).toEqual(
		expect.arrayContaining([expect.objectContaining({ writeType: "local.create_ticket" })]),
	);
	expect((await f.context.app.inject(new URL(tickets[0].url).pathname)).statusCode).toBe(200);
	await f.restart();
	expect(f.context.deps.processes.getById(id)?.externalId).toBe(tickets[0].id);
	expect((await f.context.app.inject(request)).json().childInstanceId).toBe(id);
	expect(JSON.parse(readFileSync(path.join(f.root, "tickets.json"), "utf8")).tickets).toHaveLength(
		1,
	);
}, 60000);

test("clarifies destinations, refines a draft through feedback, and declines without publishing", async ({
	f,
}) => {
	const { id } = await draft(f, "Clarify the destination before drafting.");
	const question = await waitForValue(
		() => f.context.deps.questionRequests.listOpen(id)[0],
		Boolean,
		12000,
	);
	if (!question) throw new Error("Missing destination clarification");
	expect(f.context.deps.toolApprovalRequests.listOpen(id)).toHaveLength(0);
	await f.post(`/api/processes/${id}/question-requests/${question.id}/answers`, {
		draft: [
			{ selectedOptionIds: [question.questions[0].options[0].id], freeText: "", comment: "" },
		],
	});
	const first = await decide(f, id, "feedback", "Include a daily watering schedule.");
	const revised = await approval(f, id);
	expect(revised?.id).not.toBe(first.id);
	expect(JSON.stringify(revised?.arguments)).toContain("daily watering schedule");
	await decide(f, id, "decline");
	await f.wait(id, null, "aborted");
	expect(f.context.deps.externalWrites.listByInstance(id)).toHaveLength(0);
	expect((await f.context.app.inject("/__local/state")).json().tickets).toHaveLength(0);
}, 45000);

test("launches from a retained leaf outcome and validates excerpt ownership", async ({ f }) => {
	const parent = await f.launch("ticket");
	await f.wait(parent, "plan_decision");
	// Synthetic historical outcome: the route reads its durable snapshot, never Pi text.
	f.context.deps.leafOutcomeSnapshots.create({
		instanceId: parent,
		leafEntryId: "historical-leaf",
		status: "ready",
		fallbackMarkdown: "Garden notebook: record watering dates.",
		anchoredAt: "2026-09-13T00:00:00Z",
	});
	const request = {
		method: "POST" as const,
		url: `/api/processes/${parent}/ticket-creation`,
		headers: { "idempotency-key": "historical-leaf-ticket" },
		payload: {
			toolName: "local_create_ticket",
			artifact: { kind: "leaf_outcome", leafEntryId: "historical-leaf" },
			focus: { kind: "excerpt", excerpt: "not present" },
		},
	};
	expect((await f.context.app.inject(request)).statusCode).toBe(400);
	request.payload.focus.excerpt = "record watering dates";
	const response = await f.context.app.inject(request);
	expect(response.statusCode, response.body).toBe(200);
	const id = response.json().childInstanceId;
	expect(
		JSON.parse(f.context.deps.processes.getById(id)?.paramsJson ?? "{}").context.focusedResult,
	).toBe("record watering dates");
	await decide(f, id, "accept");
	await f.wait(id, null, "completed");
	expect(f.context.deps.externalWrites.listByInstance(id)).toHaveLength(1);
}, 30000);

import { readFileSync } from "node:fs";
import path from "node:path";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect } from "vitest";
import { test } from "./forgejo-fixture.js";

test("public providers compose with ticket approvals, lost-response reconciliation and restart", async ({
	f,
}) => {
	const modules = f.context.extensionCatalog.modules.map((m) => m.module.manifest.id);
	for (const id of ["forgejo", "github", "woodpecker"])
		expect(modules.filter((m) => m === id)).toHaveLength(1);
	expect(modules).not.toContain("leitwerk-self-improvement");
	await f.post("/__local/providers/control", {
		operation: "create-issue",
		repository: "examples/garden",
		requestId: "parallel-source-issue",
	});
	const source = await waitForValue(
		() => f.context.deps.processes.listAll().find((p) => p.externalId?.startsWith("forgejo:")),
		Boolean,
		12000,
	);
	if (!source) throw new Error("Missing source discovery");
	await f.wait(source.id, "plan_decision");
	const parent = source.id;
	await f.wait(parent, "plan_decision");
	const turn = f.context.deps.turnRecords
		.listByInstance(parent)
		.find((t) => t.turnId === "generate_plan");
	if (!turn) throw new Error("Missing plan result");
	const request = {
		method: "POST" as const,
		url: `/api/processes/${parent}/ticket-creation`,
		headers: { "idempotency-key": "public-forgejo-ticket" },
		payload: {
			toolName: "forgejo_create_issue",
			artifact: { kind: "turn_result", turnRecordId: turn.id },
			focus: { kind: "whole_result" },
		},
	};
	const response = await f.context.app.inject(request);
	expect(response.statusCode, response.body).toBe(200);
	const id = response.json().childInstanceId;
	const first = await waitForValue(
		() => f.context.deps.toolApprovalRequests.listOpen(id)[0],
		Boolean,
		12000,
	);
	await f.post(`/api/processes/${id}/tool-approval-requests/${first?.id}`, {
		action: "feedback",
		feedback: "Include a daily watering schedule.",
	});
	const pending = await waitForValue(
		() => f.context.deps.toolApprovalRequests.listOpen(id)[0],
		Boolean,
		12000,
	);
	expect(JSON.stringify(pending?.arguments)).toContain("daily watering schedule");
	expect(pending?.destination).toMatchObject({ displayName: "examples/garden" });
	await f.post("/__local/providers/control", {
		operation: "lost-ticket-response",
		enabled: true,
		requestId: "lost-ticket-response",
	});
	await f.post(`/api/processes/${id}/tool-approval-requests/${pending?.id}`, { action: "accept" });
	await f.wait(id, null, "completed");
	const state = JSON.parse(readFileSync(path.join(f.root, "forgejo.json"), "utf8"));
	expect(state.repositories[0].issues).toHaveLength(2);
	expect(f.context.deps.externalWrites.listByInstance(id)).toEqual(
		expect.arrayContaining([expect.objectContaining({ writeType: "forgejo.create_issue" })]),
	);
	const declined = await f.context.app.inject({
		...request,
		headers: { "idempotency-key": "declined-forgejo-ticket" },
	});
	const declinedId = declined.json().childInstanceId;
	const declineApproval = await waitForValue(
		() => f.context.deps.toolApprovalRequests.listOpen(declinedId)[0],
		Boolean,
		12000,
	);
	await f.post(`/api/processes/${declinedId}/tool-approval-requests/${declineApproval?.id}`, {
		action: "decline",
	});
	await f.wait(declinedId, null, "aborted");
	expect(f.context.deps.externalWrites.listByInstance(declinedId)).toHaveLength(0);
	await f.restart();
	expect((await f.context.app.inject(request)).json().childInstanceId).toBe(id);
	expect(
		(await f.context.app.inject(new URL(state.repositories[0].issues[0].html_url).pathname))
			.statusCode,
	).toBe(200);
	expect(
		JSON.parse(readFileSync(path.join(f.root, "forgejo.json"), "utf8")).repositories[0].issues,
	).toHaveLength(2);
}, 60000);

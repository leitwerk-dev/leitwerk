import { readFileSync } from "node:fs";
import path from "node:path";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect, test } from "vitest";
import providerComposition from "../../../sandbox/provider-composition.js";
import { fixture } from "./fixture.js";

test("public providers compose with ticket approvals, lost-response reconciliation and restart", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished, providerComposition);
	const modules = f.context.extensionCatalog.modules.map((m) => m.module.manifest.id);
	for (const id of ["forgejo", "github", "woodpecker"])
		expect(modules.filter((m) => m === id)).toHaveLength(1);
	expect(modules).not.toContain("leitwerk-self-improvement");
	const parent = await f.launch("ticket");
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
	const pending = await waitForValue(
		() => f.context.deps.toolApprovalRequests.listOpen(id)[0],
		Boolean,
		12000,
	);
	expect(pending?.destination).toMatchObject({ displayName: "examples/garden" });
	await f.post("/__local/providers/lost-ticket-response", { enabled: true });
	await f.post(`/api/processes/${id}/tool-approval-requests/${pending?.id}`, { action: "accept" });
	await f.wait(id, null, "completed");
	const state = JSON.parse(readFileSync(path.join(f.root, "forgejo.json"), "utf8"));
	expect(state.repositories[0].issues).toHaveLength(1);
	expect(f.context.deps.externalWrites.listByInstance(id)).toEqual(
		expect.arrayContaining([expect.objectContaining({ writeType: "forgejo.create_issue" })]),
	);
	await f.restart();
	expect((await f.context.app.inject(request)).json().childInstanceId).toBe(id);
	expect(
		(await f.context.app.inject(new URL(state.repositories[0].issues[0].html_url).pathname))
			.statusCode,
	).toBe(200);
	expect(
		JSON.parse(readFileSync(path.join(f.root, "forgejo.json"), "utf8")).repositories[0].issues,
	).toHaveLength(1);
}, 60000);

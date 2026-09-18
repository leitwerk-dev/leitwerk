import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect } from "vitest";
import { control, repo, revised, test } from "../../../sandbox/testing/forgejo-fixture.js";

test("publication reconciles a lost PR response and concurrent control replays remain idempotent", async ({
	f,
}) => {
	const id = await f.launch("forgejo-change");
	await control(f, "lost-pr-response", { enabled: true });
	await f.wait(id, "plan_decision");
	await f.action(id, "approve_plan");
	await f.wait(id, "implementation_decision");
	await f.action(id, "finalize_change");
	await waitForValue(
		() => f.context.deps.processes.getById(id),
		(p) =>
			p?.lifecycleStatus === "error" ||
			(p?.selectedTurnId === "deliver_change" && p.lifecycleStatus === "waiting"),
		12000,
	);
	if (f.context.deps.processes.getById(id)?.lifecycleStatus === "error") {
		await f.restart();
		await f.post(`/api/processes/${id}/retry`);
	}
	await f.wait(id, "deliver_change");
	expect(repo(f).pulls).toHaveLength(1);
	const head = repo(f).pulls[0].head.sha;
	const input = { requestId: "concurrent-feedback-control", kind: "conversation" };
	const results = await Promise.all([control(f, "feedback", input), control(f, "feedback", input)]);
	expect(results[0].result).toEqual(results[1].result);
	expect(repo(f).feedback[repo(f).pulls[0].number]).toHaveLength(1);
	const conflict = await f.context.app.inject({
		method: "POST",
		url: "/__local/providers/control",
		payload: {
			...input,
			operation: "feedback",
			repository: "examples/garden",
			number: repo(f).pulls[0].number,
			body: "Changed request",
		},
	});
	expect(conflict.statusCode).toBe(400);
	await revised(f, id, head);
	await f.restart();
	const replay = await control(f, "feedback", input);
	expect(replay.result).toBeDefined();
	expect(repo(f).replies).toHaveLength(1);
}, 60000);

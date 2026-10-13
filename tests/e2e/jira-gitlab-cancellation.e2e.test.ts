import { describe, expect, it, onTestFinished } from "vitest";
import { jiraFixture } from "./jira-gitlab-fixture.js";
import * as scenarios from "./jira-gitlab-scenarios.js";

it.each([
	"deliver_change",
	"ci_operator_action",
] as const)("deleting one linked MR aborts all repositories from %s", async (turn) => {
	const f = await jiraFixture(onTestFinished);
	const id = await f.launch();
	if (turn === "ci_operator_action") {
		f.setRepair("operator");
		f.gitlab.pipeline(f.gitlab.state.mrs[0], "failed");
		await f.poll();
		await f.wait(id, turn);
	}
	const records = f.harness.ctx.deps.turnRecords.listByInstance(id);
	const [, remaining] = f.gitlab.state.mrs;
	f.gitlab.state.mrs.shift();
	f.gitlab.save();
	await f.poll();
	await f.wait(id, null, "aborted");
	expect(f.remote(id, "repo_1").stopped).toBe(true);
	expect(remaining.state).toBe("opened");
	expect(remaining.labels).not.toContain("leitwerk-done");
	expect(f.comments).toEqual([]);
	expect(f.issue.fields.status.name).toBe("In Review");
	await f.restart();
	await f.poll();
	await f.wait(id, null, "aborted");
	expect(f.harness.ctx.deps.turnRecords.listByInstance(id)).toEqual(records);
	await expect(f.assertMaintenance(id, "repo_2")).rejects.toThrow("ownership ended");
}, 60000);

it("deleting a linked MR fences an in-flight repair and aborts the process", async ({
	onTestFinished,
}) => {
	const f = await jiraFixture(onTestFinished);
	const id = await f.launch();
	const first = f.gitlab.state.mrs[0];
	const before = f.remote(id, "repo_1").headSha;
	const hold = f.holdRepair();
	f.gitlab.pipeline(first, "failed");
	const firstPoll = f.poll();
	try {
		await hold.entered;
		const repair = f.harness.ctx.deps.turnRecords
			.listByInstance(id)
			.find((turn) => turn.status === "running");
		expect(repair?.turnId).toBe("repair_gitlab_pipeline");
		f.gitlab.state.mrs.shift();
		f.gitlab.save();
		await f.poll();
		await f.wait(id, null, "aborted");
		expect(f.harness.ctx.deps.turnRecords.getById(repair?.id ?? "")?.status).toBe("superseded");
	} finally {
		hold.release();
		await firstPoll;
	}
	await f.poll();
	await f.wait(id, null, "aborted");
	expect(f.remote(id, "repo_1").headSha).toBe(before);
	expect(
		f.harness.ctx.deps.turnRecords
			.listByInstance(id)
			.filter((turn) => turn.turnId === "deliver_change"),
	).toHaveLength(1);
	expect(f.comments).toEqual([]);
}, 60000);

describe("Jira coordinated GitLab change", () => {
	it.each([
		"stop",
		"source",
	] as const)("does not resume blocked startup after %s cancellation", async (cancellation) => {
		const f = await jiraFixture(onTestFinished, { unmapped: true });
		const id = await f.discover();
		if (cancellation === "stop") await f.post(`/api/processes/${id}/abort`);
		else f.issue.fields.labels = [];
		await f.mapComponent("202", [1]);
		await f.pollDiscovery();
		await f.wait(id, null, "aborted");
		expect(f.harness.ctx.deps.turnStarts.listByInstance(id)).toHaveLength(0);
		expect(f.harness.ctx.deps.projects.listByInstance(id)).toHaveLength(0);
		expect(f.prompts).toHaveLength(0);
	}, 45000);

	it(
		"reconciles terminal requests before cancellation and leaves remaining open requests untouched",
		scenarios.cancelAfterMerge,
		45000,
	);

	it(
		"stops between repositories when the source is cancelled during publication",
		scenarios.cancelDuringPublication,
		45000,
	);
});

it(
	"stops one MR while the other stays maintained and reports partial completion to Jira",
	scenarios.stopOneMr,
	60000,
);

it(
	"aborts when all MRs are stopped, including while awaiting an operator",
	scenarios.stopAllMrs,
	60000,
);

it(
	"fences a running repair after remove/re-add and continues maintaining the other MR",
	scenarios.reactivatedMrRepair,
	60000,
);

it(
	"resumes an interrupted repair on the other MR without spending its CI budget again",
	scenarios.interruptedOtherMrRepair,
	60000,
);

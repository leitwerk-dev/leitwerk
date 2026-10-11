import { describe, expect, it, onTestFinished } from "vitest";
import { jiraFixture } from "./jira-gitlab-fixture.js";

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

	it("reconciles terminal requests before cancellation and leaves remaining open requests untouched", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished);
		const id = await f.launch();
		f.gitlab.merge(f.gitlab.state.mrs[0]);
		f.issue.fields.labels = [];
		await f.poll();
		await f.wait(id, null, "aborted");
		expect(f.remote(id, "repo_1").delivery.terminalPullRequest?.merged).toBe(true);
		expect(f.gitlab.state.mrs[1].state).toBe("opened");
		expect(f.comments).toEqual([]);
		expect(f.links).toHaveLength(3);
		expect(f.issue.fields.status.name).toBe("In Review");
	}, 45000);

	it("stops between repositories when the source is cancelled during publication", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished, { cancelAfterFirstPublication: true });
		const id = await f.discover();
		await f.wait(id, "plan_decision");
		await f.action(id, "approve_plan");
		await f.wait(id, null, "aborted");
		expect(f.gitlab.state.mrs).toHaveLength(1);
		expect(f.gitlab.state.mrs[0].state).toBe("opened");
		expect(f.comments).toEqual([]);
		expect(f.links).toHaveLength(2);
		expect(f.issue.fields.status.name).toBe("In Progress");
	}, 45000);
});

it("stops one MR while the other stays maintained and reports partial completion to Jira", async ({
	onTestFinished,
}) => {
	const f = await jiraFixture(onTestFinished);
	const id = await f.launch();
	const [first, second] = f.gitlab.state.mrs;
	await f.gitlab
		.client()
		.updateMergeRequestLabels(first.project_id, first.iid, { remove_labels: "leitwerk-active" });
	await f.poll();
	expect(f.remote(id, "repo_1").stopped).toBe(true);
	expect(f.harness.ctx.deps.processes.getById(id)?.lifecycleStatus).toBe("waiting");
	expect(first.state).toBe("opened");
	expect(first.labels).not.toContain("leitwerk-done");
	expect(second.labels).toContain("leitwerk-active");
	await f.restart();
	await f.poll();
	f.gitlab.merge(second);
	await f.poll();
	await f.wait(id, null, "completed");
	expect(second.labels).toContain("leitwerk-done");
	expect(first.state).toBe("opened");
	expect(first.labels).not.toContain("leitwerk-active");
	expect(f.issue.fields.labels).not.toContain("leitwerk-done");
	expect(f.issue.fields.status.name).toBe("In Review");
}, 60000);

it("aborts when all MRs are stopped, including while awaiting an operator", async ({
	onTestFinished,
}) => {
	const f = await jiraFixture(onTestFinished);
	const id = await f.launch();
	f.setRepair("operator");
	f.gitlab.pipeline(f.gitlab.state.mrs[0], "failed");
	await f.poll();
	await f.wait(id, "ci_operator_action");
	for (const mr of f.gitlab.state.mrs)
		await f.gitlab
			.client()
			.updateMergeRequestLabels(mr.project_id, mr.iid, { remove_labels: "leitwerk-active" });
	await f.poll();
	await f.wait(id, null, "aborted");
	for (const mr of f.gitlab.state.mrs) {
		expect(mr.state).toBe("opened");
		expect(mr.labels).not.toContain("leitwerk-active");
		expect(mr.labels).not.toContain("leitwerk-done");
	}
	expect(f.issue.fields.labels).not.toContain("leitwerk-done");
}, 60000);

it("fences a running repair after remove/re-add and continues maintaining the other MR", async ({
	onTestFinished,
}) => {
	const f = await jiraFixture(onTestFinished);
	const id = await f.launch();
	const [first, second] = f.gitlab.state.mrs;
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
		await f.gitlab
			.client()
			.updateMergeRequestLabels(first.project_id, first.iid, { remove_labels: "leitwerk-active" });
		await f.gitlab
			.client()
			.updateMergeRequestLabels(first.project_id, first.iid, { add_labels: "leitwerk-active" });
		await f.poll();
		expect(f.harness.ctx.deps.turnRecords.getById(repair?.id ?? "")?.status).toBe("superseded");
		expect(f.remote(id, "repo_1").stopped).toBe(true);
		expect(second.labels).toContain("leitwerk-active");
		// The new activation remains outside this process's ownership.
		expect(first.labels).toContain("leitwerk-active");
	} finally {
		hold.release();
		await firstPoll;
	}
	await f.wait(id, "deliver_change");
	await f.poll();
	expect(f.remote(id, "repo_1").headSha).toBe(before);
	expect(f.remote(id, "repo_1").stopped).toBe(true);
	expect(
		f.harness.ctx.deps.turnRecords
			.listByInstance(id)
			.filter((turn) => turn.turnId === "deliver_change"),
	).toHaveLength(1);
	await expect(f.assertMaintenance(id, "repo_1")).rejects.toThrow("ownership ended");
	f.gitlab.merge(second);
	await f.poll();
	await f.wait(id, null, "completed");
	expect(second.labels).toContain("leitwerk-done");
	expect(first.labels).not.toContain("leitwerk-done");
}, 60000);

it("resumes an interrupted repair on the other MR without spending its CI budget again", async ({
	onTestFinished,
}) => {
	const f = await jiraFixture(onTestFinished);
	const id = await f.launch();
	const [first, second] = f.gitlab.state.mrs;
	const before = f.remote(id, "repo_1").headSha;
	const hold = f.holdRepair();
	f.gitlab.pipeline(first, "failed");
	const firstPoll = f.poll();
	try {
		await hold.entered;
		await f.gitlab.client().updateMergeRequestLabels(second.project_id, second.iid, {
			remove_labels: "leitwerk-active",
		});
		await f.poll();
		expect(f.remote(id, "repo_2").stopped).toBe(true);
		expect(f.remote(id, "repo_1").ciRecoveryCycles).toBe(1);
	} finally {
		hold.release();
		await firstPoll;
	}
	await f.poll();
	await f.waitForProcess(
		id,
		() => f.remote(id, "repo_1").headSha !== before,
		"remaining MR repair published",
	);
	await f.wait(id, "deliver_change");
	expect(f.remote(id, "repo_1").ciRecoveryCycles).toBe(1);
	expect(f.remote(id, "repo_2").stopped).toBe(true);
	expect(
		f.harness.ctx.deps.turnRecords
			.listByInstance(id)
			.filter((turn) => turn.turnId === "deliver_change"),
	).toHaveLength(2);
	f.setRepair("operator");
	f.gitlab.pipeline(first, "failed");
	await f.poll();
	await f.wait(id, "ci_operator_action");
	await f.poll();
	expect(f.harness.ctx.deps.processes.getById(id)?.selectedTurnId).toBe("ci_operator_action");
}, 60000);

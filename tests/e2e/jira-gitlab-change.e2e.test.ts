import { describe, expect, it } from "vitest";
import { jiraFixture } from "./jira-gitlab-fixture.js";

describe("Jira coordinated GitLab change", () => {
	it("retries failed admission and deduplicates a renamed, relabeled issue after restart", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished);
		expect([...f.flow.process.turns.keys()]).toEqual([
			"generate_plan",
			"plan_decision",
			"implement",
			"simplify_implementation",
			"apply_simplification",
			"generate_commit_message",
			"deliver_change",
			"revise_from_merge_request_feedback",
			"repair_gitlab_pipeline",
			"ci_operator_action",
		]);
		f.setUnavailable(true);
		expect((await f.pollDiscovery()).errors.join(" ")).toContain("admission failed");
		expect(f.harness.ctx.deps.processes.listAll()).toHaveLength(0);
		f.setUnavailable(false);
		const id = await f.discover();
		await f.wait(id, "plan_decision");
		const retained = f.params(id);
		f.issue.fields.labels = [];
		await f.pollDiscovery();
		f.issue.fields.labels = ["use-leitwerk"];
		f.issue.key = "RENAMED-500";
		await f.restart();
		expect((await f.pollDiscovery()).errors).toEqual([]);
		expect(f.harness.ctx.deps.processes.listAll().map((process) => process.id)).toEqual([id]);
		expect(f.params(id)).toEqual(retained);
	}, 45000);
	it("deduplicates component repositories, hands findings to application once, and completes mixed outcomes after restart", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished, { labelDuringSimplification: true });
		f.loseComment();
		f.gitlab.loseNextMergeRequestResponse = true;
		const id = await f.launch();
		expect(f.params(id).repositories).toHaveLength(2);
		expect(f.params(id).mappings).toHaveLength(3);
		expect(f.gitlab.state.mrs).toHaveLength(2);
		const turns = f.harness.ctx.deps.turnRecords.listByInstance(id);
		expect(turns.filter((turn) => turn.turnId === "simplify_implementation")).toHaveLength(1);
		expect(turns.filter((turn) => turn.turnId === "apply_simplification")).toHaveLength(1);
		expect(f.prompts.some(({ prompt }) => prompt.includes("repo_1: remove duplication."))).toBe(
			true,
		);
		await f.poll();
		expect(f.harness.ctx.deps.processes.listAll()).toHaveLength(1);
		await f.restart();
		await f.wait(id, "deliver_change");
		f.gitlab.merge(f.gitlab.state.mrs[0]);
		f.gitlab.state.mrs[1].state = "closed";
		f.gitlab.save();
		await f.poll();
		await f.wait(id, null, "completed");
		expect(f.issue.fields.labels).not.toContain("use-leitwerk");
		expect(f.issue.fields.labels).not.toContain("leitwerk-done");
		expect(f.comments.filter((comment) => comment.body.includes("Partial result"))).toHaveLength(1);
		await f.restart();
		await f.poll();
		expect(f.gitlab.state.mrs).toHaveLength(2);
		expect(f.comments).toHaveLength(3);
	}, 60000);
	it("bypasses the current plan from its Jira label and skips both simplification turns", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished, { skipPlan: true, skipSimplification: true });
		const id = await f.launch();
		const turns = f.harness.ctx.deps.turnRecords.listByInstance(id);
		expect(
			turns.some((turn) =>
				["plan_decision", "simplify_implementation", "apply_simplification"].includes(turn.turnId),
			),
		).toBe(false);
		expect(f.state(id).routing).toMatchObject({
			plan: { skip: true, planRevision: 1 },
			simplification: { skip: true },
		});
		for (const mr of f.gitlab.state.mrs) f.gitlab.merge(mr);
		await f.poll();
		await f.wait(id, null, "completed");
		expect(f.issue.fields.labels).toContain("leitwerk-done");
		expect(f.issue.fields.status.statusCategory.key).toBe("new");
	}, 45000);
	it("accepts human comments for a plan revision and observes label bypass while approval waits", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished, { emptyFindings: true });
		const id = await f.discover();
		await f.wait(id, "plan_decision");
		await f.action(id, "request_revision", { message: "Keep the client compatible" });
		await f.wait(id, "plan_decision");
		expect(f.harness.ctx.deps.processes.getById(id)?.planRevision).toBe(2);
		// Durable waiting state can precede reconciliation of the revised plan's subscription.
		await f.waitForPlanBypass(id, 2);
		f.issue.fields.labels.push("leitwerk-skip-plan-decision");
		await f.poll();
		await f.wait(id, "deliver_change");
		expect(f.state(id).routing.plan).toMatchObject({ skip: true, planRevision: 2 });
		expect(f.prompts.some(({ prompt }) => prompt.includes("No worthwhile simplifications."))).toBe(
			true,
		);
	}, 45000);
	it("completes a no-change implementation without opening requests or adding the done label", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished, { noChanges: true });
		await f.launch();
		expect(f.gitlab.state.mrs).toHaveLength(0);
		expect(f.issue.fields.labels).toEqual([]);
		expect(f.comments[0].body).toContain("No repositories changed");
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
		expect(f.comments.at(-1)?.body).toContain("Source cancelled");
	}, 45000);
	it("repairs repositories independently and aborts when every MR closes unmerged", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished);
		const id = await f.launch();
		const secondHead = f.remote(id, "repo_2").headSha;
		f.gitlab.pipeline(f.gitlab.state.mrs[0], "failed");
		await f.poll();
		await f.waitForProcess(
			id,
			(process) =>
				JSON.parse(process.stateJson ?? "{}").extensionState?.["jiraGitLabChange:repo_1"]
					?.ciRecoveryCycles === 1 && process.lifecycleStatus === "waiting",
			"first repository repaired",
		);
		expect(f.remote(id, "repo_2").headSha).toBe(secondHead);
		expect(f.remote(id, "repo_2").ciRecoveryCycles).toBe(0);
		for (const mr of f.gitlab.state.mrs) mr.state = "closed";
		f.gitlab.save();
		await f.poll();
		await f.wait(id, null, "aborted");
		expect(f.comments.at(-1)?.body).toContain("every merge request closed");
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
		expect(f.comments.at(-1)?.body).toContain("Source cancelled");
	}, 45000);
	it("retries partial publication without duplicate requests or source comments", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished);
		const id = await f.discover();
		f.setPublicationFailure(true);
		await f.action(id, "approve_plan");
		await f.wait(id, "deliver_change", "error");
		expect(f.gitlab.state.mrs).toHaveLength(1);
		expect(f.comments).toHaveLength(1);
		f.setPublicationFailure(false);
		await f.post(`/api/processes/${id}/retry`);
		await f.wait(id, "deliver_change");
		expect(f.gitlab.state.mrs).toHaveLength(2);
		expect(f.comments).toHaveLength(2);
	}, 45000);
	it("pauses a failed simplification policy lookup and retries without guessing", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished);
		const id = await f.discover();
		f.setUnavailable(true);
		await f.action(id, "approve_plan");
		await f.wait(id, "implement", "error");
		expect(f.state(id).routing.simplification).toBeUndefined();
		f.setUnavailable(false);
		f.issue.fields.labels.push("leitwerk-skip-simplification");
		await f.post(`/api/processes/${id}/retry`);
		await f.wait(id, "deliver_change");
		expect(
			f.harness.ctx.deps.turnRecords
				.listByInstance(id)
				.some(
					(turn) =>
						turn.turnId === "simplify_implementation" || turn.turnId === "apply_simplification",
				),
		).toBe(false);
	}, 45000);
	it("rejects an empty mapping union, unavailable repositories, and changed admission snapshots", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished);
		const event = { profile: "team", issue: structuredClone(f.issue), projects: ["100"] };
		const launch = await f.flow.launcher.resolve(event);
		f.issue.fields.components = [];
		await expect(f.flow.launcher.resolve(event)).rejects.toThrow("No repositories mapped");
		f.issue.fields.components = event.issue.fields.components;
		f.gitlab.state.projects[0].archived = true;
		await expect(f.flow.launcher.resolve(event)).rejects.toThrow("must be active");
		f.gitlab.state.projects[0].archived = false;
		f.issue.fields.summary = "Changed just before admission";
		const check = f.flow.launcher
			.checks(event, launch)
			.find((check) => check.id === "jira_eligibility");
		await expect(check?.run({} as never)).rejects.toThrow("changed before admission");
	}, 45000);
});

it("settles feedback independently and escalates only the repository that exhausts three CI repairs", async ({
	onTestFinished,
}) => {
	const f = await jiraFixture(onTestFinished);
	const id = await f.launch();
	const second = f.gitlab.state.mrs[1];
	const before = f.remote(id, "repo_2").headSha;
	f.gitlab.state.feedback = {
		[`${second.project_id}:${second.iid}`]: [
			{
				id: 101,
				discussionId: "discussion-101",
				body: "Improve the client documentation",
				author: "developer",
				createdAt: new Date(0).toISOString(),
			},
		],
	};
	f.gitlab.save();
	await f.poll();
	// The first repository observation can supersede the batch's subscription generation.
	await f.poll();
	await f.waitForProcess(id, () => f.remote(id, "repo_2").headSha !== before, "feedback published");
	await f.wait(id, "deliver_change");
	const secondHead = f.remote(id, "repo_2").headSha;
	for (let cycle = 1; cycle <= 3; cycle++) {
		f.gitlab.pipeline(f.gitlab.state.mrs[0], "failed");
		await f.poll();
		await f.waitForProcess(
			id,
			() => f.remote(id, "repo_1").ciRecoveryCycles === cycle,
			"CI repair counted",
		);
		await f.wait(id, "deliver_change");
	}
	f.gitlab.pipeline(f.gitlab.state.mrs[0], "failed");
	await f.poll();
	await f.wait(id, "ci_operator_action");
	expect(f.remote(id, "repo_1").ciRecoveryCycles).toBe(3);
	expect(f.remote(id, "repo_2").ciRecoveryCycles).toBe(0);
	expect(f.remote(id, "repo_2").headSha).toBe(secondHead);
	await f.restart();
	await f.wait(id, "ci_operator_action");
	await f.action(id, "resume_waiting");
	await f.wait(id, "deliver_change");
	await f.poll();
	expect(f.harness.ctx.deps.processes.getById(id)?.selectedTurnId).toBe("deliver_change");
}, 90000);

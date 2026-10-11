import { describe, expect, it } from "vitest";
import { jiraFixture } from "./jira-gitlab-fixture.js";

describe("Jira coordinated GitLab change", () => {
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
		expect(f.comments).toEqual([]);
		expect(f.issue.fields.status.name).toBe("In Review");
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
	// The server acknowledges the published batch on its next observation.
	await f.poll();
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

it("does not replay a no-change CI repair for MR metadata updates, including after restart", async ({
	onTestFinished,
}) => {
	const f = await jiraFixture(onTestFinished);
	const id = await f.launch();
	f.setRepair("none");
	const mr = f.gitlab.state.mrs[0];
	const head = f.remote(id, "repo_1").headSha;
	const records = () => f.harness.ctx.deps.turnRecords.listByInstance(id);
	const repairs = () => records().filter((turn) => turn.turnId === "repair_gitlab_pipeline");
	const settleRepair = async (count: number) => {
		await f.waitForProcess(
			id,
			(process) =>
				repairs().length === count &&
				process.selectedTurnId === "deliver_change" &&
				process.lifecycleStatus === "waiting",
			"no-change CI repair completed",
		);
		await f.poll();
		await f.wait(id, "deliver_change");
	};
	const pipeline = f.gitlab.pipeline(mr, "failed");
	await f.poll();
	await settleRepair(1);
	expect(repairs()).toHaveLength(1);
	await f.gitlab.client().updateMergeRequestLabels(mr.project_id, mr.iid, {
		add_labels: "review-ready",
	});
	for (const status of ["preparing", "checking", "mergeable"]) {
		mr.detailed_merge_status = status;
		f.gitlab.save();
		await f.poll();
		await f.waitForProcess(
			id,
			(process) =>
				process.selectedTurnId === "deliver_change" && process.lifecycleStatus === "waiting",
			"MR observation settled",
		);
		await f.poll();
		await f.wait(id, "deliver_change");
		expect(repairs()).toHaveLength(1);
	}
	const bare = f.remotes[0];
	const target = f.git.run(bare, [
		"commit-tree",
		f.git.run(bare, ["rev-parse", "main^{tree}"]),
		"-p",
		f.git.head(bare, "main"),
		"-m",
		"Advance the target branch without changing files",
	]);
	f.git.run(bare, ["update-ref", "refs/heads/main", target]);
	await f.poll();
	await f.wait(id, "deliver_change");
	expect(repairs()).toHaveLength(1);
	await f.restart();
	await f.poll();
	await f.poll();
	await f.wait(id, "deliver_change");
	expect(repairs()).toHaveLength(1);
	expect(f.remote(id, "repo_1").ciRecoveryCycles).toBe(1);
	expect(f.remote(id, "repo_1").headSha).toBe(head);
	expect(records().filter((turn) => turn.turnId === "deliver_change")).toHaveLength(1);
	// Retrying the same pipeline can produce a new actionable failure.
	pipeline.status = "running";
	f.gitlab.save();
	await f.poll();
	pipeline.status = "failed";
	f.gitlab.save();
	await f.poll();
	await settleRepair(2);
	expect(repairs()).toHaveLength(2);
	// A distinct failed pipeline on the same revision also warrants repair.
	f.gitlab.pipeline(mr, "failed");
	await f.poll();
	await settleRepair(3);
	expect(repairs()).toHaveLength(3);
	expect(f.remote(id, "repo_1").ciRecoveryCycles).toBe(3);
	expect(records().filter((turn) => turn.turnId === "deliver_change")).toHaveLength(1);
}, 60000);

it("runs Deliver once through preparing, running and green CI, then invokes Address Feedback directly", async ({
	onTestFinished,
}) => {
	const f = await jiraFixture(onTestFinished);
	const id = await f.launch();
	const records = () => f.harness.ctx.deps.turnRecords.listByInstance(id);
	const deliveryRecords = () => records().filter((turn) => turn.turnId === "deliver_change");
	expect(deliveryRecords()).toHaveLength(1);
	const mr = f.gitlab.state.mrs[1];
	mr.detailed_merge_status = "preparing";
	f.gitlab.save();
	await f.poll();
	f.gitlab.pipeline(mr, "running");
	await f.poll();
	mr.detailed_merge_status = "mergeable";
	f.gitlab.pipeline(mr, "success");
	await f.poll();
	expect(deliveryRecords()).toHaveLength(1);
	expect(mr.labels).toContain("leitwerk-active");
	const key = `${mr.project_id}:${mr.iid}`;
	f.gitlab.state.feedback = {
		[key]: [101, 102, 103].map((noteId) => ({
			id: noteId,
			discussionId: "review-thread",
			body: `Review request ${noteId}`,
			author: "reviewer",
			createdAt: new Date(0).toISOString(),
			...(noteId === 103 ? { path: "README.md", line: 1 } : {}),
		})),
	};
	f.gitlab.save();
	const head = f.remote(id, "repo_2").headSha;
	await f.poll();
	await f.waitForProcess(
		id,
		() => f.remote(id, "repo_2").headSha !== head,
		"feedback adjustment published",
	);
	await f.poll();
	await f.wait(id, "deliver_change");
	expect(
		records()
			.filter((turn) =>
				["deliver_change", "revise_from_merge_request_feedback"].includes(turn.turnId),
			)
			.map((turn) => turn.turnId),
	).toEqual(["deliver_change", "revise_from_merge_request_feedback", "deliver_change"]);
	expect(f.remote(id, "repo_2").conversationCursor).toBe(103);
	expect(Object.values(f.gitlab.state.reactions ?? {}).flat()).toHaveLength(3);
	expect(Object.values(f.gitlab.state.discussionNotes ?? {}).flat()).toHaveLength(1);
	// A no-change outcome acknowledges its batch and resumes observation without publication.
	f.setRepair("none");
	f.gitlab.state.feedback[key].push({
		id: 104,
		discussionId: "no-change-thread",
		body: "Explain the current behavior",
		author: "reviewer",
		createdAt: new Date(0).toISOString(),
	});
	f.gitlab.save();
	await f.poll();
	await f.waitForProcess(
		id,
		() =>
			records().filter((turn) => turn.turnId === "revise_from_merge_request_feedback").length ===
				2 && f.harness.ctx.deps.processes.getById(id)?.lifecycleStatus === "waiting",
		"no-change feedback completed",
	);
	await f.poll();
	await f.wait(id, "deliver_change");
	expect(deliveryRecords()).toHaveLength(2);
	expect(f.remote(id, "repo_2").conversationCursor).toBe(104);
	expect(f.harness.ctx.deps.processes.getById(id)?.selectedTurnModelProfileId).toBeNull();
	await f.restart();
	await f.poll();
	expect(deliveryRecords()).toHaveLength(2);
	expect(Object.values(f.gitlab.state.discussionNotes ?? {}).flat()).toHaveLength(2);
}, 90000);

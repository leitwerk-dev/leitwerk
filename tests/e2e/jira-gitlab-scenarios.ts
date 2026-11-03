import { expect, type TestContext } from "vitest";
import { jiraFixture } from "./jira-gitlab-fixture.js";

/** @internal */
export async function independentRepositoryRepair({ onTestFinished }: TestContext) {
	const f = await jiraFixture(onTestFinished, { skipSimplification: true });
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
}

/** @internal */
export async function ciBudgetBoundary({ onTestFinished }: TestContext) {
	const f = await jiraFixture(onTestFinished, { listen: false, skipSimplification: true });
	const id = await f.seedDelivery(2);
	const secondHead = f.remote(id, "repo_2").headSha;
	const firstHead = f.remote(id, "repo_1").headSha;
	f.gitlab.pipeline(f.gitlab.state.mrs[0], "failed");
	await f.poll();
	await f.waitForProcess(
		id,
		() =>
			f.remote(id, "repo_1").ciRecoveryCycles === 3 && f.remote(id, "repo_1").headSha !== firstHead,
		"third CI repair published",
	);
	await f.wait(id, "deliver_change");
	expect(
		f.harness.ctx.deps.turnRecords
			.listByInstance(id)
			.filter((turn) => turn.turnId === "repair_gitlab_pipeline")
			.map((turn) => turn.status),
	).toEqual(["succeeded"]);
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
}

/** @internal */
export async function noChangeCiRepair({ onTestFinished }: TestContext) {
	const f = await jiraFixture(onTestFinished, { skipSimplification: true });
	const id = await f.launch();
	f.setRepair("none");
	const mr = f.gitlab.state.mrs[0];
	const head = f.remote(id, "repo_1").headSha;
	const records = () => f.harness.ctx.deps.turnRecords.listByInstance(id);
	const repairs = () => records().filter((turn) => turn.turnId === "repair_gitlab_pipeline");
	f.gitlab.pipeline(mr, "failed");
	await f.poll();
	await f.waitForProcess(
		id,
		(process) =>
			repairs().length === 1 &&
			process.selectedTurnId === "deliver_change" &&
			process.lifecycleStatus === "waiting",
		"no-change CI repair completed",
	);
	await f.poll();
	await f.wait(id, "deliver_change");
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
	// No-change repairs still verify source reconciliation through Deliver.
	expect(records().filter((turn) => turn.turnId === "deliver_change")).toHaveLength(2);
}

/** @internal */
export async function directFeedback({ onTestFinished }: TestContext) {
	const f = await jiraFixture(onTestFinished, { skipSimplification: true });
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
		() =>
			f.remote(id, "repo_2").headSha !== head &&
			deliveryRecords().length === 2 &&
			deliveryRecords().at(-1)?.status === "succeeded",
		"feedback adjustment delivery completed",
		30000,
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
	expect(f.gitlab.state.reactions).toEqual(
		Object.fromEntries(
			[101, 102, 103].map((noteId) => [
				`${key}:${noteId}`,
				[expect.objectContaining({ name: "eyes", user: { username: "bot" } })],
			]),
		),
	);
	expect(f.gitlab.state.discussionNotes).toEqual({
		[`${key}:review-thread`]: [expect.objectContaining({ body: expect.any(String) })],
	});
	// A no-change outcome verifies through Deliver without publishing another revision.
	const noChangeHead = f.remote(id, "repo_2").headSha;
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
				2 &&
			deliveryRecords().length === 3 &&
			deliveryRecords().at(-1)?.status === "succeeded",
		"no-change feedback delivery completed",
		30000,
	);
	await f.poll();
	await f.wait(id, "deliver_change");
	expect(deliveryRecords()).toHaveLength(3);
	expect(f.remote(id, "repo_2").headSha).toBe(noChangeHead);
	expect(f.remote(id, "repo_2").conversationCursor).toBe(104);
	expect(f.harness.ctx.deps.processes.getById(id)?.selectedTurnModelProfileId).toBeNull();
	expect(f.gitlab.state.reactions?.[`${key}:104`]).toEqual([
		expect.objectContaining({ name: "eyes", user: { username: "bot" } }),
	]);
	expect(f.gitlab.state.discussionNotes).toEqual({
		[`${key}:review-thread`]: [expect.objectContaining({ body: expect.any(String) })],
		[`${key}:no-change-thread`]: [expect.objectContaining({ body: expect.any(String) })],
	});
	const replies = structuredClone(f.gitlab.state.discussionNotes);
	const reactions = structuredClone(f.gitlab.state.reactions);
	await f.restart();
	await f.poll();
	expect(deliveryRecords()).toHaveLength(3);
	expect(f.gitlab.state.discussionNotes).toEqual(replies);
	expect(f.gitlab.state.reactions).toEqual(reactions);
}

/** @internal */
export async function cancelAfterMerge({ onTestFinished }: TestContext) {
	const f = await jiraFixture(onTestFinished, { skipSimplification: true });
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
}

/** @internal */
export async function cancelDuringPublication({ onTestFinished }: TestContext) {
	const f = await jiraFixture(onTestFinished, {
		cancelAfterFirstPublication: true,
		skipSimplification: true,
	});
	const id = await f.discover();
	await f.wait(id, "plan_decision");
	await f.action(id, "approve_plan");
	await f.wait(id, null, "aborted");
	expect(f.gitlab.state.mrs).toHaveLength(1);
	expect(f.gitlab.state.mrs[0].state).toBe("opened");
	expect(f.comments).toEqual([]);
	expect(f.links).toHaveLength(2);
	expect(f.issue.fields.status.name).toBe("In Progress");
}

/** @internal */
export async function stopOneMr({ onTestFinished }: TestContext) {
	const f = await jiraFixture(onTestFinished, { skipSimplification: true });
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
}

/** @internal */
export async function stopAllMrs({ onTestFinished }: TestContext) {
	const f = await jiraFixture(onTestFinished, { skipSimplification: true });
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
}

/** @internal */
export async function reactivatedMrRepair({ onTestFinished }: TestContext) {
	const f = await jiraFixture(onTestFinished, { skipSimplification: true });
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
}

/** @internal */
export async function interruptedOtherMrRepair({ onTestFinished }: TestContext) {
	const f = await jiraFixture(onTestFinished, { skipSimplification: true });
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
}

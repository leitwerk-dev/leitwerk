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
		expect(f.issue.fields.status.name).toBe("In Progress");
		expect(f.links.map((link) => link.object.url)).toEqual([
			`${f.harness.ctx.config.server.base_url}/processes/${id}`,
		]);
		expect(f.comments).toEqual([]);
		const retained = f.params(id);
		f.issue.fields.labels = [];
		await f.pollDiscovery();
		f.issue.fields.labels = ["use-leitwerk-beta"];
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
		f.loseRemoteLink();
		f.gitlab.loseNextMergeRequestResponse = true;
		const id = await f.launch();
		expect(f.params(id).repositories).toHaveLength(2);
		expect(f.params(id).mappings).toHaveLength(3);
		expect(f.gitlab.state.mrs).toHaveLength(2);
		const processUrl = `${f.harness.ctx.config.server.base_url}/processes/${id}`;
		expect(f.links.map((link) => link.object.url)).toEqual([
			processUrl,
			...f.gitlab.state.mrs.map((mr) => mr.web_url),
		]);
		expect(f.issue.fields.status.name).toBe("In Review");
		for (const mr of f.gitlab.state.mrs) {
			expect(mr.description).toContain(`[Leitwerk process](${processUrl})`);
			expect(mr.description).toContain(`[APP-1](${f.params(id).issueUrl})`);
		}
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
		expect(f.issue.fields.labels).not.toContain("use-leitwerk-beta");
		expect(f.issue.fields.labels).not.toContain("leitwerk-done");
		expect(f.comments).toEqual([]);
		expect(f.issue.fields.status.name).toBe("In Review");
		await f.restart();
		await f.poll();
		expect(f.gitlab.state.mrs).toHaveLength(2);
		expect(f.comments).toEqual([]);
		expect(f.links).toHaveLength(3);
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
		for (const mr of f.gitlab.state.mrs) {
			expect(mr.labels).toContain("leitwerk-done");
			expect(mr.labels).not.toContain("leitwerk-active");
		}
		expect(f.issue.fields.labels).toContain("leitwerk-done");
		expect(f.issue.fields.status.name).toBe("In Review");
		expect(f.comments).toEqual([]);
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
		const id = await f.launch();
		expect(f.gitlab.state.mrs).toHaveLength(0);
		expect(f.issue.fields.labels).toEqual([]);
		expect(f.comments).toEqual([]);
		expect(f.links.map((link) => link.object.url)).toEqual([
			`${f.harness.ctx.config.server.base_url}/processes/${id}`,
		]);
		expect(f.issue.fields.status.name).toBe("In Progress");
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
	it("retries partial publication without duplicate requests or source comments", async ({
		onTestFinished,
	}) => {
		const f = await jiraFixture(onTestFinished);
		const id = await f.discover();
		f.setPublicationFailure(true);
		await f.action(id, "approve_plan");
		await f.wait(id, "deliver_change", "error");
		expect(f.gitlab.state.mrs).toHaveLength(1);
		expect(f.comments).toEqual([]);
		expect(f.links).toHaveLength(2);
		expect(f.issue.fields.status.name).toBe("In Progress");
		f.setPublicationFailure(false);
		await f.post(`/api/processes/${id}/retry`);
		await f.wait(id, "deliver_change");
		expect(f.gitlab.state.mrs).toHaveLength(2);
		expect(f.comments).toEqual([]);
		expect(f.links).toHaveLength(3);
		expect(f.issue.fields.status.name).toBe("In Review");
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
		const event = {
			profile: "team",
			issue: structuredClone(f.issue),
			projects: ["100"],
			triggerLabel: "use-leitwerk-beta",
		};
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

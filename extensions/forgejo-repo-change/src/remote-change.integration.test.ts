import type { ProcessInstance } from "@leitwerk-dev/domain";
import { describe, expect, it, vi } from "vitest";
import {
	remoteRepoChangeFixtureConstants as constants,
	createRemoteRepoChangeFixture,
	type RemoteRepoChangeFixture,
	remoteState,
} from "./testing/diagnosed-remote-repo-change-fixture.js";
import { useRemoteRepoChangeSeed } from "./testing/remote-repo-change-seed.js";

function processInstances(fixture: RemoteRepoChangeFixture): ProcessInstance[] {
	return fixture.harness.processes().filter((process) => process.processId === constants.processId);
}

function assertCompletedRemoteChange(fixture: RemoteRepoChangeFixture, process: ProcessInstance) {
	expect(process).toMatchObject({
		lifecycleStatus: "completed",
		selectedTurnId: null,
	});
	const issue = fixture.forgejo.issue();
	expect(issue.state).toBe("closed");
	expect(issue.labels.map((label) => label.name)).not.toContain("use-leitwerk");
	expect(issue.labels.map((label) => label.name)).toContain("leitwerk-done");

	const comments = fixture.forgejo.comments();
	expect(
		comments.filter((comment) =>
			comment.startsWith(
				`Leitwerk opened pull request ${constants.prUrl}.\n\n<!-- leitwerk-write:`,
			),
		),
	).toHaveLength(1);
	expect(
		comments.filter((comment) =>
			comment.startsWith(
				`Merged ${constants.prUrl} at ${fixture.forgejo.pullRequest().merge_commit_sha}.\n\n<!-- leitwerk-write:`,
			),
		),
	).toHaveLength(1);
	expect(fixture.forgejo.calls.filter((call) => call.method === "createLabel")).toHaveLength(1);
	expect(fixture.forgejo.calls.filter((call) => call.method === "createPullRequest")).toHaveLength(
		1,
	);
	expect(fixture.forgejo.pullRequests).toHaveLength(1);
	expect(processInstances(fixture)).toHaveLength(1);
}

async function driveToPublishedPullRequest(fixture: RemoteRepoChangeFixture) {
	expect(processInstances(fixture)).toEqual([]);
	expect(fixture.git.branches()).toEqual(["main"]);
	expect(fixture.git.head("main")).toBe(fixture.git.initialSha);

	const instanceId = await fixture.exposeTriggeredIssue();
	const planDecision = await fixture.waitForTurn(instanceId, "plan_decision");
	const params = JSON.parse(planDecision.paramsJson ?? "{}") as Record<string, unknown>;
	const projects = fixture.harness.process(instanceId).snapshot().projects;
	expect(planDecision).toMatchObject({
		externalId: "forgejo:team/service#42",
		externalUrl: constants.issueUrl,
		selectedTurnId: "plan_decision",
		lifecycleStatus: "waiting",
	});
	expect(params).toMatchObject({
		baseBranch: "main",
		workBranch: constants.workBranch,
		prompt: expect.stringContaining("Update the service image"),
	});
	expect(String(params.prompt)).toContain(
		"Deploy the new service image and keep the Kubernetes manifest healthy.",
	);
	expect(projects).toEqual([
		expect.objectContaining({
			key: "repo",
			repoLocator: fixture.git.barePath,
			baseBranch: "main",
			workBranch: constants.workBranch,
		}),
	]);
	expect(processInstances(fixture)).toHaveLength(1);

	await fixture.approvePlan(instanceId);
	const implementationDecision = await fixture.waitForTurn(instanceId, "implementation_decision");
	expect(implementationDecision.lifecycleStatus).toBe("waiting");
	expect(fixture.piTurns.filter((turn) => turn.kind === "implementation")).toHaveLength(1);

	await fixture.approveImplementation(instanceId);
	const waiting = await fixture.waitForTurn(instanceId, "deliver_change");
	const head1 = fixture.git.head(constants.workBranch);
	const pr = fixture.forgejo.pullRequest();
	expect(head1).not.toBe(fixture.git.initialSha);
	expect(fixture.git.show(constants.workBranch, "k8s/deployment.yaml")).toContain(
		"image: example/service:new",
	);
	expect(fixture.git.log(constants.workBranch)[0]).toBe("feat: update service deployment image");
	expect(pr).toMatchObject({
		number: 7,
		head: { ref: constants.workBranch, sha: head1 },
		base: { ref: "main", sha: fixture.git.initialSha },
	});
	expect(remoteState(waiting)).toMatchObject({ headSha: head1, prNumber: 7 });
	expect(fixture.forgejo.comments()).toEqual([
		`Leitwerk opened pull request ${constants.prUrl}.\n\n<!-- leitwerk-write:${instanceId}:forgejo:${instanceId}:source-pr-link:7 -->`,
	]);

	return { instanceId, head1, pr };
}

// Workflow cases allow 30s for Git clones and several worker turns under shared
// CI load. Individual driver waits remain bounded.
describe("Forgejo repository-change composed integration", () => {
	let fixture: RemoteRepoChangeFixture | null = null;
	const seed = useRemoteRepoChangeSeed();
	const createFixture: typeof createRemoteRepoChangeFixture = (preflight, options) =>
		createRemoteRepoChangeFixture(preflight, { ...options, seed: seed() });

	it("reconciles a closed UI pull request without a source issue and preserves aborted status after restart", async () => {
		const dockerPreflight = vi.fn(async (_timeoutMs: number) => {});
		fixture = await createFixture(dockerPreflight);
		const instanceId = await fixture.launchTicketlessChange("Update the service image");
		const planDecision = await fixture.waitForTurn(instanceId, "plan_decision");
		// Admission and actual in-process worker startup both reach the simulated Docker boundary.
		expect(dockerPreflight.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(dockerPreflight.mock.calls.every(([timeoutMs]) => timeoutMs > 0)).toBe(true);
		const params = JSON.parse(planDecision.paramsJson ?? "{}") as Record<string, unknown>;
		expect(planDecision).toMatchObject({ externalId: null, externalUrl: null });
		expect(params).toMatchObject({
			origin: "ui",
			issueNumber: null,
			issueUrl: null,
			baseBranch: "main",
			prompt: "Update the service image",
		});
		expect(String(params.workBranch)).toMatch(
			/^update-the-service-image-[0-9a-f]{3}-[0-9a-f]{12}$/,
		);

		await fixture.approvePlan(instanceId);
		await fixture.approveImplementation(instanceId);
		await fixture.waitForTurn(instanceId, "deliver_change");
		expect(fixture.forgejo.pullRequest()).toMatchObject({
			head: { ref: params.workBranch },
			base: { ref: "main" },
		});
		await fixture.markPullRequestClosed();
		await fixture.waitForTurn(instanceId, null, "aborted");
		expect(
			fixture.forgejo.calls.filter((call) =>
				["getIssue", "updateIssue", "addIssueComment"].includes(call.method),
			),
		).toEqual([]);
		expect(fixture.forgejo.comments()).toEqual([]);
		expect(fixture.forgejo.issues).toHaveLength(0);
		const writes = fixture.harness.process(instanceId).snapshot().writeReceipts;
		await fixture.restart();
		await fixture.pollFeedback();
		expect(processInstances(fixture)).toHaveLength(1);
		expect(fixture.harness.process(instanceId).snapshot().process).toMatchObject({
			lifecycleStatus: "aborted",
			selectedTurnId: null,
		});
		expect(fixture.harness.process(instanceId).snapshot().writeReceipts).toEqual(writes);
		expect(fixture.subscriptions(instanceId)).toEqual([]);
		expect(fixture.forgejo.issues).toHaveLength(0);
	}, 30_000);

	it("launches without Docker and publishes with a non-default pinned bot identity", async () => {
		const preflight = vi.fn(async () => {
			throw new Error("No daemon");
		});
		fixture = await createFixture(preflight, {
			docker: false,
			botLogin: "garden-bot",
		});
		const id = await fixture.launchTicketlessChange("Update the service image");
		await fixture.publishChange(id);
		expect(preflight).not.toHaveBeenCalled();
		expect(fixture.harness.process(id).snapshot().projects[0]?.metadata).toMatchObject({
			"leitwerk.gitIdentity": { login: "garden-bot" },
		});
		expect(fixture.forgejo.calls.filter((c) => c.method === "getAuthenticatedUser")).toHaveLength(
			1,
		);
	}, 30_000);

	it("rejects a launch before creating a process when Docker is unavailable", async () => {
		fixture = await createFixture(async () => {
			throw new Error("simulated daemon unavailable");
		});
		await expect(fixture.launchTicketlessChange("Update the service image")).rejects.toThrow(
			"could not be created",
		);
		expect(processInstances(fixture)).toEqual([]);
		expect(fixture.piTurns).toEqual([]);
	}, 15_000);

	it("completes a labeled Forgejo issue after PR merge without reacting to successful CI", async () => {
		fixture = await createFixture();
		const { instanceId, head1 } = await driveToPublishedPullRequest(fixture);

		await fixture.publishPipeline({
			id: 501,
			number: 1,
			status: "success",
			event: "push",
			branch: constants.workBranch,
			commit: head1,
		});
		const waiting = await fixture.waitForTurn(instanceId, "deliver_change");
		expect(remoteState(waiting)).toMatchObject({
			headSha: head1,
			pipeline: null,
		});
		expect(fixture.piTurns.filter((turn) => turn.kind === "ci-repair")).toEqual([]);
		expect(fixture.woodpecker.calls.filter((call) => call.method === "restartPipeline")).toEqual(
			[],
		);

		await fixture.markPullRequestMerged();
		const completed = await fixture.waitForCompleted(instanceId);
		assertCompletedRemoteChange(fixture, completed);
	}, 30_000);

	it("filters unrelated CI and repairs exact-SHA failure after operator retry", async () => {
		fixture = await createFixture(undefined, { ciRepairBlockedOnce: true });
		const { instanceId, head1 } = await driveToPublishedPullRequest(fixture);
		const implementationTurn = fixture.piTurns.find((turn) => turn.kind === "implementation");
		expect(implementationTurn).toBeDefined();

		for (const overrides of [
			{ branch: "main", commit: head1, status: "failure" },
			{ branch: constants.workBranch, commit: fixture.git.initialSha, status: "failure" },
			{ branch: constants.workBranch, commit: head1, status: "success" },
		]) {
			await fixture.publishPipeline({ id: 501, number: 1, event: "push", ...overrides });
			const waiting = await fixture.waitForTurn(instanceId, "deliver_change");
			expect(remoteState(waiting)).toMatchObject({ headSha: head1, pipeline: null });
			expect(fixture.piTurns.filter((turn) => turn.kind === "ci-repair")).toEqual([]);
		}

		await fixture.publishPipeline({
			id: 501,
			number: 1,
			status: "failure",
			event: "pull_request",
			branch: constants.workBranch,
			commit: head1,
			workflows: [{ id: 10, status: "failure" }],
			logs: "manifest validation failed: readinessProbe is required",
		});
		const blocked = await fixture.waitForTurn(instanceId, "ci_operator_action");
		expect(remoteState(blocked)).toMatchObject({
			headSha: head1,
			ciRecoveryCycles: 1,
			pipeline: { number: 1, commit: head1 },
		});
		await fixture.action(instanceId, "retry_repair");
		const head2 = await fixture.waitForHeadChange(instanceId, head1);
		await fixture.waitForTurn(instanceId, "deliver_change");

		expect(head2).not.toBe(head1);
		expect(fixture.git.show(constants.workBranch, "k8s/deployment.yaml")).toContain(
			"readinessProbe:",
		);
		expect(fixture.git.log(constants.workBranch)[0]).toBe("fix: repair Woodpecker pipeline");
		expect(fixture.forgejo.pullRequest()).toMatchObject({
			number: 7,
			head: { ref: constants.workBranch, sha: head2 },
		});
		expect(fixture.forgejo.pullRequests).toHaveLength(1);

		const repairTurns = fixture.piTurns.filter((turn) => turn.kind === "ci-repair");
		expect(repairTurns).toHaveLength(2);
		const repairTurn = repairTurns[1];
		expect(repairTurn?.sessionId).not.toBe(repairTurns[0]?.sessionId);
		expect(repairTurn?.sessionId).not.toBe(implementationTurn?.sessionId);
		expect(repairTurn?.prompt).toContain("pipeline #1 (failure)");
		expect(repairTurn?.prompt).toContain("Woodpecker tools");
		expect(repairTurn?.prompt).toContain("bounded failed-step logs");

		const calls = fixture.woodpecker.calls;
		const pipelineReadIndex = calls.findIndex((call) => call.method === "getPipeline");
		const logReadIndex = calls.findIndex((call) => call.method === "getStepLogs");
		const lookupIndex = calls.findIndex(
			(call, index) => call.method === "lookupRepository" && index < pipelineReadIndex,
		);
		expect(lookupIndex).toBeGreaterThanOrEqual(0);
		expect(pipelineReadIndex).toBeGreaterThan(lookupIndex);
		expect(logReadIndex).toBeGreaterThan(pipelineReadIndex);
		expect(calls[logReadIndex]).toEqual({
			method: "getStepLogs",
			args: [99, 1, 10, 100, 16_384, expect.any(AbortSignal)],
		});
		expect(calls.filter((call) => call.method === "restartPipeline")).toEqual([]);
		const repaired = await fixture.waitForTurn(instanceId, "deliver_change");
		expect(remoteState(repaired)).toMatchObject({ ciRecoveryCycles: 1 });

		await fixture.publishPipeline({
			id: 502,
			number: 2,
			status: "success",
			event: "push",
			branch: constants.workBranch,
			commit: head2,
		});
		const waiting = await fixture.waitForTurn(instanceId, "deliver_change");
		expect(fixture.woodpecker.pipelines.map((pipeline) => pipeline.number)).toEqual([1, 2]);
		expect(remoteState(waiting)).toMatchObject({
			headSha: head2,
			pipeline: null,
		});

		await fixture.markPullRequestMerged();
		const completed = await fixture.waitForCompleted(instanceId);
		assertCompletedRemoteChange(fixture, completed);
	}, 30_000);
});

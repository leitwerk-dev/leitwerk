import type { ProcessInstance } from "@leitwerk-dev/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	remoteRepoChangeFixtureConstants as constants,
	createRemoteRepoChangeFixture,
	type RemoteRepoChangeFixture,
	remoteState,
} from "./testing/remote-repo-change-fixture.js";

function processInstances(fixture: RemoteRepoChangeFixture): ProcessInstance[] {
	return fixture.harness.ctx.deps.processes
		.listAll()
		.filter((process) => process.processId === constants.processId);
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
		comments.filter((comment) => comment === `Leitwerk opened pull request ${constants.prUrl}.`),
	).toHaveLength(1);
	expect(
		comments.filter(
			(comment) =>
				comment === `Merged ${constants.prUrl} at 0123456789abcdef0123456789abcdef01234567.`,
		),
	).toHaveLength(1);
	expect(fixture.forgejo.calls.filter((call) => call.method === "createLabel")).toHaveLength(1);
	expect(fixture.forgejo.calls.filter((call) => call.method === "createPullRequest")).toHaveLength(
		1,
	);
	expect(fixture.forgejo.pullRequests.size).toBe(1);
	expect(processInstances(fixture)).toHaveLength(1);
}

async function driveToPublishedPullRequest(fixture: RemoteRepoChangeFixture) {
	expect(processInstances(fixture)).toEqual([]);
	expect(fixture.git.branches()).toEqual(["main"]);
	expect(fixture.git.head("main")).toBe(fixture.git.initialSha);

	const instanceId = await fixture.exposeTriggeredIssue();
	const planDecision = await fixture.waitForTurn(instanceId, "plan_decision");
	const params = JSON.parse(planDecision.paramsJson ?? "{}") as Record<string, unknown>;
	const projects = fixture.harness.ctx.deps.projects.listByInstance(instanceId);
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
	expect(fixture.forgejo.comments()).toEqual([`Leitwerk opened pull request ${constants.prUrl}.`]);

	return { instanceId, head1, pr };
}

describe("Forgejo repository-change composed integration", () => {
	let fixture: RemoteRepoChangeFixture | null = null;
	afterEach(async () => {
		await fixture?.close();
		fixture = null;
	});

	it("launches from the UI and completes a pull request without a source issue", async () => {
		const dockerPreflight = vi.fn(async (_timeoutMs: number) => {});
		fixture = await createRemoteRepoChangeFixture(dockerPreflight);
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
		expect(fixture.forgejo.comments()).toEqual([]);
		expect(
			fixture.forgejo.calls.filter((call) =>
				["getIssue", "updateIssue", "addIssueComment"].includes(call.method),
			),
		).toEqual([]);

		await fixture.markPullRequestMerged();
		const completed = await fixture.waitForCompleted(instanceId);
		expect(completed).toMatchObject({
			lifecycleStatus: "completed",
			selectedTurnId: null,
		});
		expect(fixture.forgejo.comments()).toEqual([]);
		expect(fixture.forgejo.issues.size).toBe(0);
	}, 15_000);

	it("rejects a launch before creating a process when Docker is unavailable", async () => {
		fixture = await createRemoteRepoChangeFixture(async () => {
			throw new Error("simulated daemon unavailable");
		});
		await expect(fixture.launchTicketlessChange("Update the service image")).rejects.toThrow(
			"Ticketless launch failed with 400",
		);
		expect(processInstances(fixture)).toEqual([]);
		expect(fixture.piTurns).toEqual([]);
	}, 15_000);

	it("aborts a UI launch on a closed pull request without mutating an issue", async () => {
		fixture = await createRemoteRepoChangeFixture();
		const instanceId = await fixture.launchTicketlessChange("Update the service image");
		await fixture.approvePlan(instanceId);
		await fixture.approveImplementation(instanceId);
		await fixture.waitForTurn(instanceId, "deliver_change");

		await fixture.markPullRequestClosed();
		const aborted = await fixture.waitForAborted(instanceId);
		expect(aborted).toMatchObject({ lifecycleStatus: "aborted", selectedTurnId: null });
		expect(fixture.forgejo.comments()).toEqual([]);
		expect(fixture.forgejo.issues.size).toBe(0);
		expect(
			fixture.forgejo.calls.filter((call) =>
				["getIssue", "updateIssue", "addIssueComment"].includes(call.method),
			),
		).toEqual([]);
	}, 15_000);

	it("completes a labeled Forgejo issue after PR merge without reacting to successful CI", async () => {
		fixture = await createRemoteRepoChangeFixture();
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
	}, 15_000);

	it("repairs failed exact-SHA CI in a fresh turn and waits for the repaired SHA", async () => {
		fixture = await createRemoteRepoChangeFixture();
		const { instanceId, head1 } = await driveToPublishedPullRequest(fixture);
		const implementationTurn = fixture.piTurns.find((turn) => turn.kind === "implementation");
		expect(implementationTurn).toBeDefined();

		await fixture.publishPipeline({
			id: 501,
			number: 1,
			status: "failure",
			event: "pull_request",
			branch: constants.workBranch,
			commit: head1,
			workflows: [{ id: 10, status: "failure" }],
			stepLogs: new Map([[10, "manifest validation failed: readinessProbe is required"]]),
		});
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
		expect(fixture.forgejo.pullRequests.size).toBe(1);

		const repairTurn = fixture.piTurns.find((turn) => turn.kind === "ci-repair");
		expect(repairTurn).toBeDefined();
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
			args: [99, 1, 10, 100, 16_384],
		});
		expect(calls.filter((call) => call.method === "restartPipeline")).toEqual([]);
		expect(
			fixture.harness.ctx.deps.turnRecords
				.listByInstance(instanceId)
				.some((turn) => turn.turnId === "ci_operator_action"),
		).toBe(false);

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
	}, 15_000);
});

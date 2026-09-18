import { FORGEJO_ISSUE_CANCELLED_KIND } from "@leitwerk-dev/forgejo";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect, it, onTestFinished } from "vitest";
import {
	remoteRepoChangeFixtureConstants as constants,
	createRemoteRepoChangeFixture,
	type RemoteRepoChangeFixture,
} from "./testing/diagnosed-remote-repo-change-fixture.js";

async function publishIssue(f: RemoteRepoChangeFixture) {
	const id = await f.exposeTriggeredIssue();
	await f.approvePlan(id);
	await f.approveImplementation(id);
	await waitForValue(
		() => f.subscriptions(id).some((source) => source.kind === FORGEJO_ISSUE_CANCELLED_KIND),
		Boolean,
		12_000,
	);
	return id;
}

it("closing an unmerged issue-origin PR removes the trigger, comments once, and leaves the issue open", async () => {
	const f = await createRemoteRepoChangeFixture();
	onTestFinished(() => f.close());
	const id = await publishIssue(f);
	await f.markPullRequestClosed();
	await f.waitForTurn(id, null, "aborted");
	expect(f.forgejo.issue()).toMatchObject({ state: "open", labels: [] });
	expect(f.forgejo.comments()).toEqual([
		`Leitwerk opened pull request ${constants.prUrl}.`,
		`Leitwerk stopped because ${constants.prUrl} was closed without merge.`,
	]);
	const writes = f.harness.ctx.deps.externalWrites.listByInstance(id);
	expect(writes.length).toBeGreaterThan(0);
	await f.restart();
	await f.pollFeedback();
	expect(f.harness.ctx.deps.processes.listAll()).toHaveLength(1);
	expect(f.harness.ctx.deps.processes.getById(id)).toMatchObject({
		lifecycleStatus: "aborted",
		selectedTurnId: null,
	});
	expect(f.forgejo.issue()).toMatchObject({ state: "open", labels: [] });
	expect(f.forgejo.comments()).toHaveLength(2);
	expect(f.harness.ctx.deps.externalWrites.listByInstance(id)).toEqual(writes);
	expect(f.subscriptions(id)).toEqual([]);
}, 15_000);

it("source cancellation aborts waiting delivery without another worker turn or reconciliation write", async () => {
	const f = await createRemoteRepoChangeFixture();
	onTestFinished(() => f.close());
	const id = await publishIssue(f);
	const workerTurns = () =>
		f.harness.ctx.deps.turnRecords
			.listByInstance(id)
			.filter((turn) => turn.turnType !== "external");
	const turns = workerTurns();
	const writes = f.harness.ctx.deps.externalWrites.listByInstance(id);
	const comments = f.forgejo.comments();
	await f.removeSourceTrigger();
	await f.waitForTurn(id, null, "aborted");
	expect(workerTurns()).toEqual(turns);
	expect(f.harness.ctx.deps.externalWrites.listByInstance(id)).toEqual(writes);
	expect(f.forgejo.comments()).toEqual(comments);
	expect(f.forgejo.pullRequest()).toMatchObject({ state: "open", merged: false });
	expect(f.subscriptions(id)).toEqual([]);
}, 15_000);

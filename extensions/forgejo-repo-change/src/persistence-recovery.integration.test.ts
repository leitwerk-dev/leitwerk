import { LocalForgejoAdapter } from "@leitwerk-dev/forgejo/testing";
import { expect, it, onTestFinished } from "vitest";
import {
	remoteRepoChangeFixtureConstants as constants,
	createRemoteRepoChangeFixture,
	type RemoteRepoChangeFixture,
	remoteState,
} from "./testing/remote-repo-change-fixture.js";

async function reopenLegacyDelivery(f: RemoteRepoChangeFixture, id: string, issueOrigin: boolean) {
	const { deps } = f.harness.ctx;
	const retained = deps.processes.getById(id);
	if (!retained) throw new Error("Missing delivery");
	const params = JSON.parse(retained.paramsJson ?? "{}");
	if (issueOrigin) delete params.origin;
	deps.processes.update(id, { paramsJson: JSON.stringify(params) });
	const project = deps.projects.listByInstance(id)[0];
	const metadata = { ...project.metadata };
	delete metadata.woodpecker;
	metadata.forgejo = {
		owner: params.owner,
		repo: params.repo,
		...(issueOrigin ? { issueNumber: params.issueNumber } : {}),
	};
	deps.projects.update(project.id, { metadata });
	const turns = deps.turnRecords.listByInstance(id);
	const writes = deps.externalWrites.listByInstance(id);
	const subscriptions = f.subscriptions(id);
	const plan = turns.find((turn) => turn.turnId === "generate_plan");
	if (!plan) throw new Error("Missing planning turn");
	const reasoningUrl = `/api/processes/${id}/turn-records/${plan.id}/reasoning`;
	const reasoning = (await f.harness.ctx.app.inject(reasoningUrl)).json().reasoning;
	expect(JSON.stringify(reasoning)).toContain("Plan the manifest change before implementation.");
	expect(writes.some((write) => write.writeType === "forgejo.ensure_pr")).toBe(true);
	expect(subscriptions.length).toBeGreaterThan(0);
	f.harness.config.extensions["forgejo-repo-change"] = {
		profile_bindings: {
			team: { woodpecker_profile: "future-ci", ssh_credential_ref: "future-ssh" },
		},
	};
	const previousContext = f.harness.ctx;
	const previousAdapter = f.forgejo;
	await f.restart();
	expect(f.harness.ctx).not.toBe(previousContext);
	expect(f.forgejo).not.toBe(previousAdapter);
	await f.waitForTurn(id, "deliver_change");
	expect(f.harness.ctx.deps.processes.getById(id)).toMatchObject({
		paramsJson: JSON.stringify(params),
		stateJson: retained.stateJson,
		selectedTurnId: retained.selectedTurnId,
	});
	expect(f.harness.ctx.deps.projects.listByInstance(id)[0]).toMatchObject({
		id: project.id,
		metadata,
	});
	expect(f.harness.ctx.deps.turnRecords.listByInstance(id)).toEqual(turns);
	expect(f.harness.ctx.deps.externalWrites.listByInstance(id)).toEqual(writes);
	expect(f.subscriptions(id)).toEqual(subscriptions);
	expect((await f.harness.ctx.app.inject(reasoningUrl)).json().reasoning).toEqual(reasoning);
}

it("reopens armed UI delivery with legacy project bindings and repairs CI using retained profiles", async () => {
	const f = await createRemoteRepoChangeFixture();
	onTestFinished(() => f.close());
	const id = await f.publishChange(await f.launchTicketlessChange("Update the service image"));
	const pr = f.forgejo.pullRequest();
	await reopenLegacyDelivery(f, id, false);
	await f.publishPipeline({
		id: 501,
		number: 1,
		status: "failure",
		event: "push",
		branch: pr.head.ref,
		commit: pr.head.sha,
		workflows: [{ id: 10, status: "failure" }],
		logs: "readinessProbe is required",
	});
	const head = await f.waitForHeadChange(id, pr.head.sha);
	const waiting = await f.waitForTurn(id, "deliver_change");
	expect(remoteState(waiting)).toMatchObject({ headSha: head, ciRecoveryCycles: 1 });
	expect(f.woodpecker.calls.some((call) => call.method === "getStepLogs")).toBe(true);
	expect(f.forgejo.pullRequests).toHaveLength(1);
	await f.markPullRequestMerged();
	await f.waitForCompleted(id);
	await f.restart();
	await f.pollFeedback();
	expect(f.subscriptions(id)).toEqual([]);
	expect(f.forgejo.pullRequests).toHaveLength(1);
	expect(f.forgejo.issues).toHaveLength(0);
}, 30_000);

it("reconciles an offline merge for a legacy issue delivery once after subscription rearming", async () => {
	const f = await createRemoteRepoChangeFixture();
	onTestFinished(() => f.close());
	const id = await f.publishChange(await f.exposeTriggeredIssue());
	const pr = f.forgejo.pullRequest();
	await reopenLegacyDelivery(f, id, true);
	await f.restart(async () => {
		const provider = new LocalForgejoAdapter({ root: f.root, baseUrl: "https://forgejo.example" });
		provider.merge(provider.repo(constants.owner, constants.repo), pr.number);
	});
	await f.pollFeedback();
	await f.waitForCompleted(id);
	expect(f.forgejo.issue()).toMatchObject({
		state: "closed",
		labels: [expect.objectContaining({ name: "leitwerk-done" })],
	});
	expect(f.forgejo.comments()).toHaveLength(2);
	const comments = f.forgejo.comments();
	const replies = structuredClone(f.forgejo.replies);
	const writes = f.harness.ctx.deps.externalWrites.listByInstance(id);
	await f.restart();
	await f.pollFeedback();
	expect(f.forgejo.comments()).toEqual(comments);
	expect(f.forgejo.replies).toEqual(replies);
	expect(f.harness.ctx.deps.externalWrites.listByInstance(id)).toEqual(writes);
	expect(f.forgejo.pullRequests).toHaveLength(1);
	expect(f.subscriptions(id)).toEqual([]);
}, 30_000);

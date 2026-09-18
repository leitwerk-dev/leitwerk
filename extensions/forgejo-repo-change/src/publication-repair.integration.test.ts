import { readFileSync } from "node:fs";
import path from "node:path";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect, it, onTestFinished } from "vitest";
import {
	createRemoteRepoChangeFixture,
	type RemoteRepoChangeFixture,
	remoteState,
} from "./testing/diagnosed-remote-repo-change-fixture.js";

function state(f: RemoteRepoChangeFixture, id: string) {
	const process = f.harness.ctx.deps.processes.getById(id);
	if (!process) throw new Error(`Missing process ${id}`);
	return remoteState(process);
}

async function publish(f: RemoteRepoChangeFixture) {
	const id = await f.launchTicketlessChange("Update the service image", {
		docker: false,
		sshCredentialRef: "untrusted",
	});
	await f.approvePlan(id);
	await f.approveImplementation(id);
	await f.waitForTurn(id, "deliver_change");
	return id;
}

it("UI publication retains provider bindings and reasoning, completes without an issue, and replays on a fresh branch", async () => {
	const f = await createRemoteRepoChangeFixture();
	onTestFinished(() => f.close());
	const id = await publish(f);
	const pr = structuredClone(f.forgejo.pullRequest());
	const project = f.harness.ctx.deps.projects.listByInstance(id)[0];
	expect(project.metadata).toMatchObject({
		forgejo: { profile: "team" },
		woodpecker: { profile: "team" },
	});
	expect(f.git.show(pr.head.ref, "k8s/deployment.yaml")).toContain("image: example/service:new");
	expect(
		f.harness.ctx.deps.externalWrites
			.listByInstance(id)
			.some((write) => write.writeType === "forgejo.ensure_pr"),
	).toBe(true);
	const turn = f.harness.ctx.deps.turnRecords
		.listByInstance(id)
		.find((record) => record.turnId === "generate_plan");
	if (!turn) throw new Error("Missing planning turn");
	const reasoning = await f.harness.ctx.app.inject(
		`/api/processes/${id}/turn-records/${turn.id}/reasoning`,
	);
	expect(reasoning.statusCode).toBe(200);
	expect(reasoning.json().reasoning.piInput.fullPrompt).toContain("Update the service image");
	expect(reasoning.json().reasoning.assistant.thinking).toContain("Plan the manifest change");
	await f.markPullRequestMerged();
	await f.waitForCompleted(id);
	expect(f.forgejo.issues).toHaveLength(0);
	const replay = await f.launchTicketlessChange("Update the service image");
	expect(replay).not.toBe(id);
	expect(f.harness.ctx.deps.projects.listByInstance(replay)[0].workBranch).not.toBe(pr.head.ref);
}, 30000);

it("batches conversation, inline and review feedback into a fresh revision and retains replies after restart", async () => {
	const f = await createRemoteRepoChangeFixture(undefined, { feedbackOutcome: "changes_ready" });
	onTestFinished(() => f.close());
	const id = await publish(f);
	const pr = structuredClone(f.forgejo.pullRequest());
	const feedback = (["conversation", "inline", "review"] as const).map((kind) =>
		f.forgejo.addFeedback(pr.number, kind),
	);
	expect(state(f, id).headSha).toBe(pr.head.sha);
	await f.pollFeedback();
	await f.pollFeedback();
	const head = await f.waitForHeadChange(id, pr.head.sha);
	await f.waitForTurn(id, "deliver_change");
	await waitForValue(
		() => f.forgejo.replies.length,
		(count) => count === 3,
	);
	expect(f.forgejo.reactions).toHaveLength(2);
	expect(f.forgejo.replies).toHaveLength(3);
	const turns = f.harness.ctx.deps.turnRecords.listByInstance(id);
	const original = turns.find((turn) => turn.turnId === "implement");
	const revisions = turns.filter((turn) => turn.turnId === "revise_from_pull_request_feedback");
	expect(original).toBeDefined();
	expect(revisions).toHaveLength(1);
	expect(revisions[0].id).not.toBe(original?.id);
	expect(revisions[0].forkPiEntryId).toBeNull();
	expect(f.git.show(head, "README.md")).toContain("Reviewed deployment configuration");
	expect(f.forgejo.replies.map(({ feedbackId }) => feedbackId).sort()).toEqual(
		feedback.map(({ id }) => id).sort(),
	);
	const replies = structuredClone(f.forgejo.replies);
	const reactions = structuredClone(f.forgejo.reactions);
	await f.restart();
	await f.waitForTurn(id, "deliver_change");
	await f.pollFeedback();
	expect(f.forgejo.replies).toEqual(replies);
	expect(f.forgejo.reactions).toEqual(reactions);
	expect(f.forgejo.pullRequests).toHaveLength(1);
	expect(f.harness.ctx.deps.turnRecords.listByInstance(id)).toEqual(turns);
}, 30000);

it("diagnoses CI and explicitly restarts through a durable write without republishing or restarting again after app restart", async () => {
	const f = await createRemoteRepoChangeFixture(undefined, { ciRestart: true });
	onTestFinished(() => f.close());
	const id = await publish(f);
	const pr = structuredClone(f.forgejo.pullRequest());
	await f.publishPipeline({
		id: 501,
		number: 1,
		status: "failure",
		event: "push",
		branch: pr.head.ref,
		commit: pr.head.sha,
		workflows: [{ id: 10, status: "failure" }],
		logs: "runner unavailable",
	});
	await waitForValue(
		() => f.woodpecker.pipelines[0]?.status,
		(status) => status === "pending",
	);
	await f.waitForTurn(id, "deliver_change");
	expect(state(f, id).headSha).toBe(pr.head.sha);
	const calls = f.woodpecker.calls.map((call) => call.method);
	expect(calls.indexOf("getStepLogs")).toBeGreaterThanOrEqual(0);
	expect(calls.indexOf("restartPipeline")).toBeGreaterThan(calls.indexOf("getStepLogs"));
	expect(calls.filter((method) => method === "restartPipeline")).toHaveLength(1);
	const writes = f.harness.ctx.deps.externalWrites.listByInstance(id);
	expect(writes.filter((write) => write.writeType === "woodpecker.restart")).toHaveLength(1);
	await f.restart();
	await f.waitForTurn(id, "deliver_change");
	await f.publishPipeline({ ...f.woodpecker.pipelines[0] });
	expect(f.woodpecker.pipelines).toHaveLength(1);
	expect(f.woodpecker.calls.filter((call) => call.method === "restartPipeline")).toHaveLength(0);
	expect(f.harness.ctx.deps.externalWrites.listByInstance(id)).toEqual(writes);
	expect(f.forgejo.pullRequest().head.sha).toBe(pr.head.sha);
}, 30000);

it("rebases a conflicting base after app restart and publishes with the retained original-head lease", async () => {
	const f = await createRemoteRepoChangeFixture();
	onTestFinished(() => f.close());
	const id = await publish(f);
	const pr = structuredClone(f.forgejo.pullRequest());
	await f.restart();
	await f.waitForTurn(id, "deliver_change");
	const baseSha = await f.conflictBase();
	const head = await f.waitForHeadChange(id, pr.head.sha);
	await f.waitForTurn(id, "deliver_change");
	expect(f.git.local.isAncestor(f.git.barePath, baseSha, head)).toBe(true);
	const manifest = f.git.show(head, "k8s/deployment.yaml");
	expect(manifest).toContain("Base update: preserve deployment notes");
	expect(manifest).toContain("image: example/service:new");
	expect(f.harness.ctx.deps.projects.listByInstance(id)[0].workBranch).toBe(pr.head.ref);
	const record = JSON.parse(
		readFileSync(
			path.join(
				f.harness.config.storage.process_workspaces_dir,
				id,
				"repo",
				".git",
				"leitwerk-rebase.json",
			),
			"utf8",
		),
	);
	expect(record).toMatchObject({ originalHead: pr.head.sha, branch: pr.head.ref });
	expect(f.forgejo.pullRequest().head.sha).toBe(head);
	await f.pollFeedback();
	expect(state(f, id).headSha).toBe(head);
	expect(f.forgejo.pullRequests).toHaveLength(1);
	await f.markPullRequestMerged();
	await f.waitForCompleted(id);
}, 60000);

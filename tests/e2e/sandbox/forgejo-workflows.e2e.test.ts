import { readFileSync } from "node:fs";
import path from "node:path";
import type { LocalForgejoState } from "@leitwerk-dev/forgejo/testing";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import type { LocalWoodpeckerState } from "@leitwerk-dev/woodpecker/testing";
import { expect, test } from "vitest";
import providerComposition from "../../../sandbox/provider-composition.js";
import { type Fixture, fixture } from "./fixture.js";

const providers = (f: Fixture) => ({
	forgejo: JSON.parse(readFileSync(path.join(f.root, "forgejo.json"), "utf8")) as LocalForgejoState,
	ci: JSON.parse(
		readFileSync(path.join(f.root, "woodpecker.json"), "utf8"),
	) as LocalWoodpeckerState,
});
const repo = (f: Fixture) => providers(f).forgejo.repositories[0];
const remote = (f: Fixture, id: string) =>
	JSON.parse(f.context.deps.processes.getById(id)?.stateJson ?? "{}").extensionState
		.forgejoRepoChange;
let sequence = 0;
async function control(f: Fixture, operation: string, input: Record<string, unknown> = {}) {
	return (
		await f.post("/__local/providers/control", {
			operation,
			repository: "examples/garden",
			number: repo(f).pulls[0]?.number,
			requestId: `workflow-control-${++sequence}`,
			...input,
		})
	).json();
}
async function publish(f: Fixture, id: string) {
	await f.wait(id, "plan_decision");
	await f.action(id, "approve_plan");
	await f.wait(id, "implementation_decision");
	await f.action(id, "finalize_change");
	await f.wait(id, "deliver_change");
	const pr = repo(f).pulls.find(
		(p) =>
			p.head.ref ===
			JSON.parse(f.context.deps.processes.getById(id)?.paramsJson ?? "{}").workBranch,
	);
	if (!pr) throw new Error("No pull request");
	return pr;
}
async function source(f: Fixture) {
	const response = await control(f, "create-issue");
	const issue = response.result;
	const p = await waitForValue(
		() =>
			f.context.deps.processes
				.listAll()
				.find((p) => p.externalId === `forgejo:examples/garden#${issue.number}`),
		Boolean,
		12000,
	);
	if (!p) throw new Error("Watcher did not discover source");
	return { id: p.id, issue };
}
async function revised(f: Fixture, id: string, head: string) {
	await waitForValue(
		() => remote(f, id).headSha,
		(value) => value !== head,
		12000,
	);
	await f.wait(id, "deliver_change");
}

test("real UI launcher publishes, records sessions, completes, and replays on a new branch", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished, providerComposition);
	const input = {
		forgejoProfile: "local",
		repository: "examples/garden",
		prompt: "Document watering",
		docker: true,
		sshCredentialRef: "untrusted",
	};
	const id = await f.launch("forgejo_repo_change_process.ui_launcher", input, true);
	const pr = await publish(f, id);
	const project = f.context.deps.projects.listByInstance(id)[0];
	expect(project.metadata).toMatchObject({
		forgejo: { profile: "local" },
		woodpecker: { profile: "local" },
	});
	const diff = await f.context.app.inject(
		`/__local/providers/diff/${repo(f).repository.id}/${pr.number}`,
	);
	expect(diff.json().diff).toContain("Weekly review");
	expect(
		f.context.deps.externalWrites
			.listByInstance(id)
			.some((w) => w.writeType === "forgejo.ensure_pr"),
	).toBe(true);
	const turn = f.context.deps.turnRecords
		.listByInstance(id)
		.find((t) => t.turnId === "generate_plan");
	if (!turn) throw new Error("No planning turn");
	const reasoning = await f.context.app.inject(
		`/api/processes/${id}/turn-records/${turn.id}/reasoning`,
	);
	expect(reasoning.json().reasoning.piInput.fullPrompt).toContain("Document watering");
	expect(reasoning.json().reasoning.assistant.thinking).toContain("recorded provider evidence");
	await control(f, "merge");
	await f.wait(id, null, "completed");
	expect(repo(f).issues).toHaveLength(0);
	const replay = await f.launch("forgejo_repo_change_process.ui_launcher", input, true);
	await f.wait(replay, "plan_decision");
	expect(
		JSON.parse(f.context.deps.processes.getById(replay)?.paramsJson ?? "{}").workBranch,
	).not.toBe(pr.head.ref);
}, 60000);

test("source discovery is durable and merge finalizes the issue once", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished, providerComposition);
	const { id, issue } = await source(f);
	await publish(f, id);
	await f.post("/__local/poll");
	expect(f.context.deps.processes.listAll()).toHaveLength(1);
	const merged = await control(f, "merge", { requestId: "source-merge-once" });
	await f.wait(id, null, "completed");
	expect(repo(f).issues[0]).toMatchObject({
		state: "closed",
		labels: [expect.objectContaining({ name: "leitwerk-done" })],
	});
	expect(repo(f).comments[issue.number]).toHaveLength(2);
	await f.restart();
	const replay = await control(f, "merge", { requestId: "source-merge-once" });
	expect(replay.result).toEqual(merged.result);
	expect(replay.write.performed).toBe(false);
	expect(repo(f).comments[issue.number]).toHaveLength(2);
}, 60000);

test("feedback batches conversation, inline and review evidence, then replies once in a fresh turn", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished, providerComposition);
	const id = await f.launch("forgejo-change");
	const pr = await publish(f, id);
	for (const kind of ["conversation", "inline", "review"]) await control(f, "feedback", { kind });
	expect(remote(f, id).headSha).toBe(pr.head.sha);
	await f.post("/__local/poll");
	await revised(f, id, pr.head.sha);
	expect(repo(f).reactions).toHaveLength(2);
	expect(repo(f).replies).toHaveLength(3);
	const turns = f.context.deps.turnRecords.listByInstance(id);
	const original = turns.find((t) => t.turnId === "implement");
	const revision = turns.find((t) => t.turnId === "revise_from_pull_request_feedback");
	if (!original || !revision) throw new Error("Missing implementation or feedback turn");
	expect(revision).toBeDefined();
	expect(revision.id).not.toBe(original.id);
	expect(revision.forkPiEntryId).toBeNull();
	await f.restart();
	await f.post("/__local/poll");
	expect(repo(f).replies).toHaveLength(3);
	expect(repo(f).pulls).toHaveLength(1);
}, 60000);

for (const scene of ["forgejo-feedback-no-change", "forgejo-feedback-operator"])
	test(`${scene} routes without publishing an unexplained change`, async ({ onTestFinished }) => {
		const f = await fixture(onTestFinished, providerComposition);
		const id = await f.launch(scene),
			pr = await publish(f, id);
		await control(f, "feedback");
		await f.post("/__local/poll");
		if (scene.endsWith("operator")) {
			await f.wait(id, "ci_operator_action");
			await f.action(id, "resume_waiting");
			await f.wait(id, "deliver_change");
		} else {
			await waitForValue(
				() => repo(f).replies?.length,
				(n) => n === 1,
				12000,
			);
			await f.wait(id, "deliver_change");
		}
		expect(remote(f, id).headSha).toBe(pr.head.sha);
	}, 60000);

test("CI ignores stale branch/head and success, repairs three times, then allows operator recovery", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished, providerComposition);
	const id = await f.launch("forgejo-change"),
		pr = await publish(f, id);
	await control(f, "pipeline", { branch: "main", status: "failure" });
	expect(remote(f, id).ciRecoveryCycles).toBe(0);
	await control(f, "pipeline");
	await revised(f, id, pr.head.sha);
	await control(f, "pipeline", { sha: pr.head.sha, status: "failure" });
	expect(remote(f, id).ciRecoveryCycles).toBe(1);
	await control(f, "pipeline"); // deterministic check now passes
	expect(remote(f, id).ciRecoveryCycles).toBe(1);
	for (let n = 2; n <= 3; n++) {
		const head = remote(f, id).headSha;
		await control(f, "pipeline", { status: "failure" });
		await revised(f, id, head);
	}
	await control(f, "pipeline", { status: "failure" });
	await f.wait(id, "ci_operator_action");
	expect(remote(f, id).ciRecoveryCycles).toBe(3);
	await f.action(id, "retry_repair");
	await f.wait(id, "deliver_change");
	expect(repo(f).pulls).toHaveLength(1);
}, 60000);

test("CI diagnosis restarts explicitly through a durable write", async ({ onTestFinished }) => {
	const f = await fixture(onTestFinished, providerComposition);
	const id = await f.launch("forgejo-ci-restart"),
		pr = await publish(f, id);
	await control(f, "pipeline", { status: "failure" });
	await waitForValue(
		() => providers(f).ci.repositories[0].pipelines[0].status,
		(v) => v === "pending",
		12000,
	);
	await f.wait(id, "deliver_change");
	expect(remote(f, id).headSha).toBe(pr.head.sha);
	expect(
		f.context.deps.externalWrites
			.listByInstance(id)
			.some((w) => w.writeType === "woodpecker.restart"),
	).toBe(true);
	await f.restart();
	await f.post("/__local/poll");
	expect(providers(f).ci.repositories[0].pipelines).toHaveLength(1);
}, 60000);

test("a conflicting base commit is rebased and published with its retained lease", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished, providerComposition);
	const id = await f.launch("forgejo-change"),
		pr = await publish(f, id);
	const result = await control(f, "conflict");
	await revised(f, id, pr.head.sha);
	const r = repo(f),
		head = remote(f, id).headSha;
	const git = new LocalGit(f.root);
	expect(git.isAncestor(r.repository.ssh_url, result.result.baseSha, head)).toBe(true);
	expect(git.run(r.repository.ssh_url, ["show", `${head}:notes.txt`])).toContain("Base update");
	const project = f.context.deps.projects.listByInstance(id)[0];
	const recordPath = path.join(
		f.config.storage.process_workspaces_dir,
		id,
		"repo",
		".git",
		"leitwerk-rebase.json",
	);
	// The project identity survives repair; Git records the original publication lease.
	expect(project.workBranch).toBe(pr.head.ref);
	expect(readFileSync(recordPath, "utf8")).toContain(pr.head.sha);
	await f.post("/__local/poll");
	expect(remote(f, id).headSha).toBe(head);
	await control(f, "merge");
	await f.wait(id, null, "completed");
}, 60000);

for (const origin of ["ui", "issue"])
	test(`closing a PR reconciles ${origin} origin once`, async ({ onTestFinished }) => {
		const f = await fixture(onTestFinished, providerComposition);
		const id = origin === "ui" ? await f.launch("forgejo-change") : (await source(f)).id;
		await publish(f, id);
		await control(f, "close");
		await f.wait(id, null, "aborted");
		if (origin === "issue") {
			expect(repo(f).issues[0]).toMatchObject({ state: "open", labels: [] });
			expect(repo(f).comments[repo(f).issues[0].number]).toHaveLength(2);
		} else expect(repo(f).issues).toHaveLength(0);
		await f.restart();
		await f.post("/__local/poll");
		expect(f.context.deps.processes.listAll()).toHaveLength(1);
	}, 60000);

for (const operation of ["cancel-issue", "remove-trigger"])
	test(`${operation} aborts waiting delivery without another worker turn`, async ({
		onTestFinished,
	}) => {
		const f = await fixture(onTestFinished, providerComposition);
		const { id, issue } = await source(f);
		await publish(f, id);
		const turns = f.context.deps.turnRecords
			.listByInstance(id)
			.filter((t) => t.turnType !== "external").length;
		await control(f, operation, { number: issue.number });
		await f.wait(id, null, "aborted");
		expect(
			f.context.deps.turnRecords.listByInstance(id).filter((t) => t.turnType !== "external"),
		).toHaveLength(turns);
	}, 60000);

test("provider controls reject escaping repositories, mismatched IDs and nonlocal requests", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished, providerComposition);
	for (const payload of [
		{ operation: "create-issue", repository: "../outside", requestId: "outside-repository" },
		{
			operation: "merge",
			repository: "examples/garden",
			number: 9999,
			requestId: "unknown-pull-request",
		},
		{ operation: "set-lifecycle", requestId: "forbidden-lifecycle" },
	]) {
		expect(
			(await f.context.app.inject({ method: "POST", url: "/__local/providers/control", payload }))
				.statusCode,
		).toBe(400);
	}
	expect(
		(
			await f.context.app.inject({
				method: "POST",
				url: "/__local/providers/control",
				headers: { origin: "https://outside.example" },
				payload: { operation: "create-issue" },
			})
		).statusCode,
	).toBe(403);
	expect(f.context.deps.processes.listAll()).toHaveLength(0);
}, 60000);

test("publication reconciles a lost PR response and concurrent control replays remain idempotent", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished, providerComposition);
	const id = await f.launch("forgejo-change");
	await control(f, "lost-pr-response", { enabled: true });
	await f.wait(id, "plan_decision");
	await f.action(id, "approve_plan");
	await f.wait(id, "implementation_decision");
	await f.action(id, "finalize_change");
	await waitForValue(
		() => f.context.deps.processes.getById(id),
		(p) =>
			p?.lifecycleStatus === "error" ||
			(p?.selectedTurnId === "deliver_change" && p.lifecycleStatus === "waiting"),
		12000,
	);
	if (f.context.deps.processes.getById(id)?.lifecycleStatus === "error") {
		await f.restart();
		await f.post(`/api/processes/${id}/retry`);
	}
	await f.wait(id, "deliver_change");
	expect(repo(f).pulls).toHaveLength(1);
	const head = repo(f).pulls[0].head.sha;
	const input = { requestId: "concurrent-feedback-control", kind: "conversation" };
	const results = await Promise.all([control(f, "feedback", input), control(f, "feedback", input)]);
	expect(results.map((r) => r.write.performed).sort()).toEqual([false, true]);
	expect(repo(f).feedback[repo(f).pulls[0].number]).toHaveLength(1);
	const conflict = await f.context.app.inject({
		method: "POST",
		url: "/__local/providers/control",
		payload: {
			...input,
			operation: "feedback",
			repository: "examples/garden",
			number: repo(f).pulls[0].number,
			body: "Changed request",
		},
	});
	expect(conflict.statusCode).toBe(400);
	await revised(f, id, head);
	await f.restart();
	const replay = await control(f, "feedback", input);
	expect(replay.write.performed).toBe(false);
	expect(repo(f).replies).toHaveLength(1);
}, 60000);

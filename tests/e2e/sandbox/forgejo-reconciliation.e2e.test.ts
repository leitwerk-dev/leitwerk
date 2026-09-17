import { readFileSync } from "node:fs";
import path from "node:path";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { expect } from "vitest";
import {
	control,
	providers,
	publish,
	remote,
	repo,
	revised,
	source,
	test,
} from "./forgejo-fixture.js";

test("CI diagnosis restarts explicitly through a durable write", async ({ f }) => {
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
	f,
}) => {
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
	test(`closing a PR reconciles ${origin} origin once`, async ({ f }) => {
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
	test(`${operation} aborts waiting delivery without another worker turn`, async ({ f }) => {
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
	f,
}) => {
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
	f,
}) => {
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

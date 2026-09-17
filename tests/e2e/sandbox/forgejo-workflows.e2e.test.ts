import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { expect } from "vitest";
import { control, publish, remote, repo, revised, source, test } from "./forgejo-fixture.js";

test("real UI launcher publishes, records sessions, completes, and replays on a new branch", async ({
	f,
}) => {
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

test("source discovery is durable and merge finalizes the issue once", async ({ f }) => {
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
	f,
}) => {
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

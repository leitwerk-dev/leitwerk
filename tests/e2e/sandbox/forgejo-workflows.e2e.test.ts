import { expect } from "vitest";
import { control, publish, repo, source, test } from "../../../sandbox/testing/forgejo-fixture.js";

test("source discovery is durable and merge finalizes the issue once", async ({ f }) => {
	const { id, issue } = await source(f);
	const pr = await publish(f, id);
	const diff = await f.context.app.inject(
		`/__local/providers/diff/${repo(f).repository.id}/${pr.number}`,
	);
	expect(diff.statusCode).toBe(200);
	expect(diff.json().diff).toContain("Weekly review");
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

import { expect, it } from "vitest";
import { pullRequestArgs, toolContext, toolFixture } from "./testing/tool-fixture.js";

const ensure = "github_ensure_pull_request";
it("uses only the authorized project repository and profile", async () => {
	const f = toolFixture();
	await f.execute(ensure, pullRequestArgs);
	expect(f.requests.every((r) => r.owner === "team" && r.repo === "one")).toBe(true);
	expect(f.profiles.length).toBeGreaterThan(0);
	expect(new Set(f.profiles)).toEqual(new Set(["first"]));
	expect(f.tools.has("github_resolve_release_lock")).toBe(false);
});

it.each([
	"wrong process",
	"missing project",
	"missing binding",
	"malformed binding",
])("rejects %s before provider access", async (kind) => {
	const f = toolFixture();
	let ctx = toolContext();
	if (!ctx.project) throw new Error("Missing fixture project");
	if (kind === "wrong process") ctx.project.instanceId = "other";
	if (kind === "missing binding") ctx.project.metadata = {};
	if (kind === "malformed binding")
		ctx.project.metadata = { github: { owner: "team", repo: "one", profile: 42 } };
	if (kind === "missing project") ctx = { ...ctx, project: null };
	await expect(f.execute(ensure, pullRequestArgs, ctx)).rejects.toThrow();
	expect(f.profiles).toEqual([]);
	expect(f.writes.records).toEqual([]);
});

it.each(["head", "base"])("rejects a mismatched %s without a write", async (branch) => {
	const f = toolFixture();
	await expect(f.execute(ensure, { ...pullRequestArgs, [branch]: "wrong" })).rejects.toThrow(
		"branches must match",
	);
	expect(f.requests).toEqual([]);
	expect(f.writes.records).toEqual([]);
});

it.each([
	"none",
	"after",
] as const)("reconciles create response %s and replay into one receipt", async (failure) => {
	const f = toolFixture();
	f.failure.create = failure;
	const pr = await f.execute(ensure, pullRequestArgs);
	await expect(f.execute(ensure, pullRequestArgs)).resolves.toEqual(pr);
	expect(f.pulls).toHaveLength(1);
	expect(f.requests.filter((r) => r.method === "create")).toHaveLength(1);
	expect(f.writes.records).toMatchObject([
		{
			dedupKey: "retained-pr-key",
			writeType: "github.ensure_pr",
			metadata: { number: 1, url: f.pulls[0].html_url },
		},
	]);
});

it("records a receipt for an existing PR without creating another", async () => {
	const f = toolFixture();
	await f.execute(ensure, pullRequestArgs);
	const ctx = { ...toolContext(), idempotencyKey: "new-receipt" };
	await f.execute(ensure, pullRequestArgs, ctx);
	expect(f.requests.filter((r) => r.method === "create")).toHaveLength(1);
	expect(f.writes.records).toHaveLength(2);
	expect(f.writes.records[1]).toMatchObject({ dedupKey: "new-receipt", metadata: { number: 1 } });
});

it("propagates a failed create without recording success", async () => {
	const f = toolFixture();
	f.failure.create = "before";
	await expect(f.execute(ensure, pullRequestArgs)).rejects.toThrow("create rejected");
	expect(f.pulls).toEqual([]);
	expect(f.writes.records).toEqual([]);
});

it.each([false, true])("reconciles comment replay with response loss=%s", async (lost) => {
	const f = toolFixture();
	const args = { projectKey: "one", pullRequestNumber: 1, body: "Reviewed" };
	f.failure.comment = lost;
	await f.execute("github_add_pull_request_comment", args);
	f.failure.comment = false;
	await f.execute("github_add_pull_request_comment", args);
	await f.execute("github_add_pull_request_comment", args);
	expect(f.comments).toEqual([{ body: "Reviewed\n\n<!-- leitwerk-write:p:retained-pr-key -->" }]);
	expect(f.requests.filter((r) => r.method === "comment")).toHaveLength(1);
	expect(f.writes.records).toHaveLength(1);
});

it("does not overwrite an accepted update on replay", async () => {
	const f = toolFixture();
	await f.execute(ensure, pullRequestArgs);
	const ctx = { ...toolContext(), idempotencyKey: "update-key" };
	for (const title of ["Updated", "Should not replay"]) {
		await f.execute(
			"github_update_pull_request",
			{ projectKey: "one", pullRequestNumber: 1, patch: { title } },
			ctx,
		);
	}
	expect(f.pulls[0].title).toBe("Updated");
	expect(f.requests.filter((r) => r.method === "update")).toHaveLength(1);
	expect(f.writes.records).toHaveLength(2);
});

it("recovers a closed PR and refuses to recreate it if it disappears after logging", async () => {
	const f = toolFixture();
	await f.execute(ensure, pullRequestArgs);
	f.pulls[0].state = "closed";
	await expect(f.execute(ensure, pullRequestArgs)).resolves.toMatchObject({ state: "closed" });
	f.pulls.length = 0;
	await expect(f.execute(ensure, pullRequestArgs)).rejects.toMatchObject({
		name: "ExternalWriteMissingRemoteError",
	});
	expect(f.requests.filter((r) => r.method === "create")).toHaveLength(1);
});

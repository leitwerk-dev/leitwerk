import type { ExternalWrites } from "@leitwerk-dev/external-writes";
import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	GitLabClient,
	type GitLabClientLike,
	type GitLabPipeline,
	gitLabMergeabilityPending,
	gitLabMergeRepairReason,
	observeMergeRequest,
	parseGitLabProfiles,
} from "./client.js";
import { mr } from "./merge-request.test-fixture.js";
import { parseGitLabSelection, selectGitLabProjects } from "./selection.js";
import { ensureGitLabComment, ensureGitLabSeenReaction } from "./tools.js";

async function writeHarness(execute: (writes: ExternalWrites) => Promise<unknown>) {
	const harness = await createExtensionTestHarness({
		extensions: [
			{
				manifest: { id: "gitlab-write-test", version: "1" },
				setupServer(api) {
					api.tool({
						name: "write",
						description: "Exercise the GitLab write boundary",
						parameters: {},
						execute: (ctx) => execute(ctx.externalWrites),
					});
				},
			},
		],
	});
	onTestFinished(() => harness.close());
	return harness;
}

const profile = { baseUrl: "https://forge.test", token: "secret-token" };
const pipeline = (id: number, status: string, sha = "head"): GitLabPipeline => ({
	id,
	status,
	sha,
	project_id: 7,
	ref: "renovate/dependency",
	source: "merge_request_event",
	web_url: `https://forge.test/pipelines/${id}`,
});
describe("GitLab boundary", () => {
	it.each([
		[{ has_conflicts: true }, "conflict"],
		[{ detailed_merge_status: "conflict", has_conflicts: false }, "conflict"],
		[{ detailed_merge_status: "need_rebase" }, "rebase"],
		[{ detailed_merge_status: "not_approved" }, null],
		[{ detailed_merge_status: "ci_must_pass" }, null],
		[{ merge_status: "cannot_be_merged" }, null],
		[{ detailed_merge_status: "checking", has_conflicts: true }, null],
		[{ detailed_merge_status: "unchecked" }, null],
		[{}, null],
	] as const)("classifies merge repair evidence %j as %s", (fields, reason) => {
		expect(gitLabMergeRepairReason({ ...mr, ...fields })).toBe(reason);
	});
	it("observes conflicts without CI and reads the current target tip instead of diff_refs", async () => {
		const getBranch = vi.fn(async () => ({ commit: { id: "current-target" } }));
		const client = {
			getMergeRequest: async () => ({
				...mr,
				has_conflicts: true,
				detailed_merge_status: "conflict",
				diff_refs: { base_sha: "old-base", head_sha: mr.sha, start_sha: "old-target" },
			}),
			getBranch,
			listMergeRequestPipelines: async () => [],
			listBranchPipelines: async () => [],
		} as unknown as GitLabClientLike;
		const observed = await observeMergeRequest(client, 7, 1);
		expect(observed).toMatchObject({
			targetHead: "current-target",
			pipeline: null,
			mr: { has_conflicts: true },
		});
		expect(getBranch).toHaveBeenCalledWith(7, "main", undefined);
		expect(gitLabMergeabilityPending({ ...mr, detailed_merge_status: "preparing" })).toBe(true);
	});
	it("adds its own eyes reaction once despite another user's reaction and a lost write response", async () => {
		const reactions = [{ id: 1, name: "eyes", user: { username: "reviewer" } }];
		let posts = 0;
		const request = vi.fn(async (url: URL | Request | string, options?: RequestInit) => {
			const u = new URL(String(url));
			if (u.pathname.endsWith("/user"))
				return Response.json({ username: "bot", name: "Bot", email: "bot@test" });
			expect(u.pathname).toBe("/api/v4/projects/7/merge_requests/1/notes/42/award_emoji");
			if (options?.method === "POST") {
				expect(JSON.parse(String(options.body))).toEqual({ name: "eyes" });
				posts++;
				reactions.push({ id: 2, name: "eyes", user: { username: "bot" } });
				throw new Error("Response lost after write");
			}
			return Response.json(reactions);
		});
		const input = {
			client: new GitLabClient(profile, { fetch: request as typeof fetch }),
			instanceId: "process",
			projectId: 7,
			iid: 1,
			noteId: 42,
		};
		const harness = await writeHarness((writes) => ensureGitLabSeenReaction({ ...input, writes }));
		await harness.callTool("write", {});
		const reads = request.mock.calls.length;
		await harness.callTool("write", {});
		expect(request).toHaveBeenCalledTimes(reads + 2);
		const reopened = await writeHarness((writes) => ensureGitLabSeenReaction({ ...input, writes }));
		await reopened.callTool("write", {});
		expect(posts).toBe(1);
		expect(reactions).toHaveLength(2);
	});
	it.each([
		undefined,
		"inline/thread",
	])("reconciles a lost comment/reply response and write-log loss (discussion: %s)", async (discussionId) => {
		const notes: { id: number; body: string }[] = [];
		let posts = 0;
		const request = vi.fn(async (url: URL | Request | string, options?: RequestInit) => {
			const u = new URL(String(url));
			const target = `/api/v4/projects/7/merge_requests/1${discussionId ? "/discussions/inline%2Fthread" : ""}`;
			if (options?.method === "POST") {
				expect(u.pathname).toBe(`${target}/notes`);
				posts++;
				notes.push({ id: posts, body: JSON.parse(String(options.body)).body });
				if (!discussionId) throw new Error("lost response");
				return new Response("write completed, response unavailable", { status: 503 });
			}
			expect(u.pathname).toBe(discussionId ? target : `${target}/notes`);
			return Response.json(discussionId ? { id: discussionId, notes } : notes);
		});
		const input = {
			client: new GitLabClient(profile, { fetch: request as typeof fetch }),
			instanceId: "process",
			projectId: 7,
			iid: 1,
			discussionId,
			writeKey: "feedback:42",
			body: "Addressed in commit abc; CI passed.",
		};
		const harness = await writeHarness((writes) => ensureGitLabComment({ ...input, writes }));
		const first = await harness.callTool("write", {});
		expect(first).toMatchObject({ marker: expect.any(String) });
		expect(notes[0]?.body).toContain((first as { marker: string }).marker);
		await harness.callTool("write", {});
		const reopened = await writeHarness((writes) => ensureGitLabComment({ ...input, writes }));
		await reopened.callTool("write", {});
		expect(posts).toBe(1);
	});
	it("reads paginated conversation and inline feedback while excluding bot and system notes", async () => {
		const note = (id: number, extra = {}) => ({
			id,
			body: `comment ${id}`,
			created_at: "2026-09-16T10:00:00Z",
			system: false,
			author: { username: "reviewer" },
			...extra,
		});
		const request = vi.fn(async (url: URL | Request | string) => {
			const u = new URL(String(url));
			if (u.pathname.endsWith("/user"))
				return Response.json({ username: "leitwerk", name: "Bot", email: "bot@test" });
			expect(u.pathname).toBe("/api/v4/projects/7/merge_requests/1/discussions");
			if (u.searchParams.get("page") === "2")
				return Response.json([
					{
						id: "inline",
						notes: [
							note(7, { position: { new_path: "settings.gradle.kts", new_line: 1 } }),
							note(8),
						],
					},
				]);
			return Response.json(
				[
					{
						id: "general",
						notes: [
							note(1),
							note(2, { system: true }),
							note(3, { author: { username: "leitwerk" } }),
							note(4, { author: { username: "automation", bot: true } }),
							note(5, { resolved: true }),
							note(6, { created_at: "invalid" }),
							note(9, {
								author: { username: "leitwerk" },
								body: `Generated reply\n\n<!-- leitwerk:gitlab:${"a".repeat(64)} -->`,
							}),
						],
					},
				],
				{ headers: { "x-next-page": "2" } },
			);
		});
		const feedback = await new GitLabClient(profile, {
			fetch: request as typeof fetch,
		}).listMergeRequestFeedback(7, 1);
		expect(feedback.map((item) => item.id)).toEqual([1, 3, 7, 8]);
		expect(feedback[3]).toMatchObject({
			discussionId: "inline",
			path: "settings.gradle.kts",
			line: 1,
			author: "reviewer",
		});
	});
	it("encodes nested project/group paths, follows pagination and keeps the token in the request header", async () => {
		const calls: string[] = [];
		const request = vi.fn(async (url: URL | Request | string, options?: RequestInit) => {
			calls.push(String(url));
			expect(options?.headers).toMatchObject({ "PRIVATE-TOKEN": "secret-token" });
			return Response.json(
				[{ id: calls.length, path_with_namespace: "team/platform/services/control" }],
				{ headers: { "x-next-page": calls.length === 1 ? "2" : "" } },
			);
		});
		const client = new GitLabClient(profile, { fetch: request as typeof fetch });
		expect(await client.listGroupProjects("team/platform/services")).toHaveLength(2);
		expect(calls[0]).toContain("/groups/team%2Fplatform%2Fservices/projects?");
		expect(calls[1]).toContain("page=2");
		await client.getProject("team/platform/services/control");
		expect(calls[2]).toContain("/projects/team%2Fplatform%2Fservices%2Fcontrol");
		await client.listProjects();
		expect(calls[3]).toContain("/projects?archived=false");
		expect(calls[3]).not.toContain("membership=true");
		expect(JSON.stringify(client)).not.toContain(profile.token);
	});
	it("retries transient reads and bounds trace bytes without reading the entire response", async () => {
		const sleep = vi.fn(async () => {});
		const request = vi
			.fn()
			.mockResolvedValueOnce(new Response("private response", { status: 503 }))
			.mockResolvedValueOnce(new Response("0123456789"));
		expect(await new GitLabClient(profile, { fetch: request, sleep }).getJobTrace(7, 1, 4)).toEqual(
			{ text: "0123", truncated: true },
		);
		expect(sleep).toHaveBeenCalledTimes(1);
	});
	it("never retries an uncertain write directly and redacts failed responses", async () => {
		const request = vi.fn(
			async () => new Response("secret-token: internal error", { status: 503 }),
		);
		await expect(
			new GitLabClient(profile, { fetch: request as typeof fetch }).addNote(7, 1, "hello"),
		).rejects.toThrow("GitLab request failed (503)");
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("requires a safe origin and usable authenticated bot identity", async () => {
		for (const baseUrl of [
			"http://forge.test",
			"https://user:secret@forge.test",
			"https://forge.test/path",
		])
			expect(() => new GitLabClient({ ...profile, baseUrl })).toThrow();
		expect(() =>
			parseGitLabProfiles({
				profiles: { x: { base_url: "https://user:secret@gitlab.test", token: "x" } },
			}),
		).toThrow();
		const request = vi.fn(async () => Response.json({ username: "bot", name: "Bot" }));
		await expect(
			new GitLabClient(profile, { fetch: request as typeof fetch }).resolveGitIdentity(),
		).rejects.toThrow("identity is unavailable");
		expect(
			await new GitLabClient(
				{ ...profile, gitIdentity: { name: "Bot", email: "bot@test" } },
				{ fetch: request as typeof fetch },
			).resolveGitIdentity(),
		).toMatchObject({ email: "bot@test" });
	});
	it("prefers the newest current MR pipeline including pending and validates synthetic merge ancestry", async () => {
		const older = pipeline(1, "failed"),
			pending = pipeline(2, "pending"),
			synthetic = { ...pipeline(3, "failed", "merge"), ref: "refs/merge-requests/1/merge" };
		const client = {
			getMergeRequest: async () => mr,
			getBranch: async () => ({ commit: { id: "target" } }),
			listMergeRequestPipelines: async () => [older, pending, synthetic],
			getPipeline: async (_id: number, id: number) =>
				[older, pending, synthetic].find((p) => p.id === id)!,
			getCommit: async () => ({ parent_ids: ["stale", "target"] }),
		} as unknown as GitLabClientLike;
		expect((await observeMergeRequest(client, 7, 1)).pipeline?.id).toBe(2);
		client.getCommit = async () => ({
			id: "merge",
			message: "merge",
			parent_ids: ["target", "head"],
		});
		expect((await observeMergeRequest(client, 7, 1)).pipeline?.id).toBe(3);
	});
	it("falls back to the current source-branch push pipeline, ignoring other revisions", async () => {
		const client = {
			getMergeRequest: async () => mr,
			getBranch: async () => ({ commit: { id: "target" } }),
			listMergeRequestPipelines: async () => [],
			listBranchPipelines: async () => [
				{ ...pipeline(1, "failed", "old"), source: "push" },
				{ ...pipeline(2, "running"), source: "push" },
			],
			getPipeline: async () => ({ ...pipeline(2, "running"), source: "push" }),
		} as unknown as GitLabClientLike;
		expect((await observeMergeRequest(client, 7, 1)).pipeline?.status).toBe("running");
	});
	it("uses selector union, subgroup exclusions and stable ID deduplication", async () => {
		const control = { id: 1, path_with_namespace: "team/platform/services/control" };
		const other = { id: 2, path_with_namespace: "team/platform/services/other" };
		const excluded = { id: 3, path_with_namespace: "team/platform/private/service" };
		const client = {
			getProject: async () => control,
			listGroupProjects: async () => [control, other, excluded],
		} as unknown as GitLabClientLike;
		const exact = parseGitLabSelection({ projects: { include: [control.path_with_namespace] } });
		expect((await selectGitLabProjects(client, exact)).map((p) => p.id)).toEqual([1]);
		const union = parseGitLabSelection({
			projects: { include: [control.path_with_namespace], exclude: [other.path_with_namespace] },
			groups: { include: ["team/platform"], exclude: ["team/platform/private"] },
		});
		expect((await selectGitLabProjects(client, union)).map((p) => p.id)).toEqual([1]);
		expect(() => parseGitLabSelection({})).toThrow("explicit");
	});
});

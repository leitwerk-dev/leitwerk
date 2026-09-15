import { createInMemoryExternalWriteLog } from "@leitwerk-dev/test-support";
import { describe, expect, it, vi } from "vitest";
import {
	GitLabClient,
	type GitLabClientLike,
	type GitLabMergeRequest,
	type GitLabPipeline,
	observeMergeRequest,
	parseGitLabProfiles,
} from "./client.js";
import { parseGitLabSelection, selectGitLabProjects } from "./selection.js";
import { ensureGitLabComment } from "./tools.js";

const profile = { baseUrl: "https://forge.test", token: "secret-token" };
const mr: GitLabMergeRequest = {
	iid: 1,
	project_id: 7,
	source_project_id: 7,
	target_project_id: 7,
	title: "Upgrade",
	description: null,
	state: "opened",
	labels: ["renovate"],
	sha: "head",
	source_branch: "renovate/dependency",
	target_branch: "main",
	web_url: "https://forge.test/a/-/merge_requests/1",
};
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
	it("reconciles a comment after a lost response and after local write-log loss", async () => {
		const notes: { id: number; body: string }[] = [];
		let writes = 0;
		const client = {
			baseUrl: profile.baseUrl,
			listNotes: async () => notes,
			addNote: async (_id: number, _iid: number, body: string) => {
				notes.push({ id: ++writes, body });
				throw new Error("lost response");
			},
		} as unknown as GitLabClientLike;
		const input = {
			client,
			writes: createInMemoryExternalWriteLog(),
			instanceId: "process",
			projectId: 7,
			iid: 1,
			writeKey: "cycle:1",
			body: "Giving up",
		};
		const first = await ensureGitLabComment(input);
		expect(notes[0]?.body).toContain(first.marker);
		await ensureGitLabComment({ ...input, writes: createInMemoryExternalWriteLog() });
		expect(writes).toBe(1);
	});
});

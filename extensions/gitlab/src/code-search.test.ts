import type { ProcessProject } from "@leitwerk-dev/domain";
import type { IntegrationToolExecutionContext } from "@leitwerk-dev/process-sdk";
import { createToolCollector } from "@leitwerk-dev/test-support";
import { expect, it, vi } from "vitest";
import { GitLabClient, type GitLabClientLike } from "./client.js";
import { registerGitLabTools } from "./tools.js";

const sha = "a".repeat(40);
const profile = { baseUrl: "https://forge.test", token: "private-test-token" };
it("pins basic project search to a commit and returns pages, snippets, and explicit completion", async () => {
	const requests: URL[] = [];
	const client = new GitLabClient(profile, {
		fetch: async (url, init) => {
			const request = new URL(String(url));
			requests.push(request);
			expect(init?.headers).toMatchObject({ "PRIVATE-TOKEN": profile.token });
			return Response.json(
				request.searchParams.get("page") === "1"
					? [{ path: "src/db.ts", data: "connect(user)", startline: 12 }]
					: [],
				{ headers: { "x-next-page": request.searchParams.get("page") === "1" ? "2" : "" } },
			);
		},
	});
	expect(await client.searchRepositoryCode(7, sha, "connect filename:*.ts", 1, 20)).toEqual({
		revision: sha,
		page: 1,
		nextPage: 2,
		results: [{ path: "src/db.ts", snippet: "connect(user)", startLine: 12 }],
	});
	expect(await client.searchRepositoryCode(7, sha, "connect filename:*.ts", 2, 20)).toMatchObject({
		results: [],
		nextPage: null,
	});
	expect(requests[0].pathname).toBe("/api/v4/projects/7/search");
	expect(Object.fromEntries(requests[0].searchParams)).toEqual({
		scope: "blobs",
		search_type: "basic",
		ref: sha,
		search: "connect filename:*.ts",
		page: "1",
		per_page: "20",
	});
	await expect(client.searchRepositoryCode(7, "main", "connect")).rejects.toThrow("full commit");
	await expect(client.searchRepositoryCode(7, sha, "connect", 0)).rejects.toThrow("pagination");
});
it.each([403, 404, 500])("does not turn search failure %s into no matches", async (status) => {
	const request = vi.fn(async () => new Response("secret server response", { status }));
	const client = new GitLabClient(profile, { fetch: request, sleep: async () => {} });
	await expect(client.searchRepositoryCode(7, sha, "db")).rejects.toThrow(`(${status})`);
	expect(request).toHaveBeenCalledTimes(status === 500 ? 3 : 1);
});
it("propagates cancellation without retrying", async () => {
	const controller = new AbortController();
	const request = vi.fn(async (_url, init) => {
		controller.abort();
		init?.signal?.throwIfAborted();
		return Response.json([]);
	});
	const client = new GitLabClient(profile, { fetch: request });
	await expect(client.searchRepositoryCode(7, sha, "db", 1, 20, controller.signal)).rejects.toThrow(
		"network unavailable",
	);
	expect(request).toHaveBeenCalledOnce();
});
it("authorizes search through the process binding and reports unavailable capability", async () => {
	const { api, tools } = createToolCollector();
	const search = vi.fn(async () => ({ revision: sha, results: [], page: 1, nextPage: null }));
	const client = {
		baseUrl: profile.baseUrl,
		searchRepositoryCode: search,
	} as unknown as GitLabClientLike;
	registerGitLabTools(api, { profiles: () => ["test"], client: () => client });
	const project = {
		instanceId: "process",
		key: "repo",
		metadata: { gitlab: { profile: "test", origin: profile.baseUrl, projectId: 7 } },
	} as ProcessProject;
	const ctx = {
		process: { id: "process" },
		project,
		signal: new AbortController().signal,
	} as IntegrationToolExecutionContext;
	const tool = tools.get("gitlab_code_search")!;
	expect(tool.parameters.required).toEqual(["projectKey", "ref", "search"]);
	expect(tools.get("gitlab_repository_file")?.parameters.required).toEqual([
		"projectKey",
		"ref",
		"path",
	]);
	expect(tools.get("gitlab_repository_tree")?.parameters.required).toEqual(["projectKey", "ref"]);
	expect(tools.get("gitlab_inspect_project")?.parameters.required).toEqual(["projectKey"]);
	await expect(
		tool.execute(
			{ ...ctx, project: { ...project, instanceId: "other" } },
			{ ref: sha, search: "db" },
		),
	).rejects.toThrow("authorized");
	expect(search).not.toHaveBeenCalled();
	await tool.execute(ctx, { ref: sha, search: "db", page: 2, perPage: 10 });
	expect(search).toHaveBeenCalledWith(7, sha, "db", 2, 10, ctx.signal);
	client.searchRepositoryCode = undefined;
	await expect(tool.execute(ctx, { ref: sha, search: "db" })).rejects.toThrow("unavailable");
});

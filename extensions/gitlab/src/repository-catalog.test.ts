import {
	createCapabilityAccessor,
	type ScopedSettingsResolver,
	scopedSettingsCapability,
} from "@leitwerk-dev/process-sdk";
import { createToolCollector } from "@leitwerk-dev/test-support";
import { expect, it, vi } from "vitest";
import { type GitLabIntegration, gitlabIntegration } from "./capability.js";
import { GitLabClient, type GitLabClientLike, type GitLabProject } from "./client.js";
import { createGitLabRepositoryCatalog } from "./repository-catalog.js";
import { setupGitLabIntegration } from "./setup.js";

const project = (id: number, name = `team/project-${id}`): GitLabProject => ({
	id,
	path_with_namespace: name,
	http_url_to_repo: `https://gitlab.test/${name}.git`,
	web_url: `https://gitlab.test/${name}`,
	default_branch: "main",
});
function fixture() {
	const listProjects = vi.fn(async () => [project(1)]);
	const searchProjects = vi.fn(async () => [project(1)]);
	const client = {
		baseUrl: "https://gitlab.test",
		listProjects,
		searchProjects,
	} as unknown as GitLabClientLike;
	const integration: GitLabIntegration = { profiles: () => ["team"], client: () => client };
	return {
		listProjects,
		searchProjects,
		client,
		integration,
		catalog: createGitLabRepositoryCatalog(integration),
	};
}

it("searches one remote page without scanning the catalog, sharing and caching normalized queries", async () => {
	const request = vi.fn(async (_input: URL | Request | string) =>
		Response.json([project(1, "team/customer")], { headers: { "x-next-page": "2" } }),
	);
	const client = new GitLabClient(
		{ baseUrl: "https://gitlab.test", token: "fixture-token" },
		{ fetch: request },
	);
	const catalog = createGitLabRepositoryCatalog({ profiles: () => ["team"], client: () => client });
	expect(await catalog.search("team", "")).toEqual([]);
	expect(await catalog.search("team", " c ")).toEqual([]);
	expect(request).not.toHaveBeenCalled();
	const [first, second] = await Promise.all([
		catalog.search("team", " CUSTOMER "),
		catalog.search("team", "customer"),
	]);
	expect(second).toEqual(first);
	expect(await catalog.search("team", "customer")).toEqual(first);
	expect(request).toHaveBeenCalledTimes(1);
	const url = new URL(String(request.mock.calls[0][0]));
	expect(url.pathname).toBe("/api/v4/projects");
	expect(Object.fromEntries(url.searchParams)).toMatchObject({
		search: "customer",
		archived: "false",
		per_page: "100",
		page: "1",
	});
	expect(catalog.peek("team", 1)?.path_with_namespace).toBe("team/customer");
});

it("retries failed searches and replaces query metadata only after a successful full refresh", async () => {
	const f = fixture();
	f.searchProjects.mockRejectedValueOnce(new Error("Search unavailable"));
	await expect(f.catalog.search("team", "project")).rejects.toThrow("Search unavailable");
	expect((await f.catalog.search("team", "project"))[0].id).toBe(1);
	f.listProjects.mockRejectedValueOnce(new Error("Refresh unavailable"));
	await expect(f.catalog.refresh("team")).rejects.toThrow("Refresh unavailable");
	expect((await f.catalog.search("team", "project"))[0].id).toBe(1);
	expect(f.searchProjects).toHaveBeenCalledTimes(2);
	f.listProjects.mockResolvedValueOnce([project(2)]);
	await f.catalog.refresh("team");
	expect(f.catalog.peek("team", 1)).toBeUndefined();
	expect((await f.catalog.search("team", "project"))[0].id).toBe(2);
	expect(f.searchProjects).toHaveBeenCalledTimes(2);
});

it("shares a complete paginated scan across Settings reads until an explicit refresh", async () => {
	let name = "original";
	const request = vi.fn(async (input: URL | Request | string) => {
		const page = Number(new URL(String(input)).searchParams.get("page") ?? "1");
		return Response.json([project(page, `team/${name}-${page}`)], {
			headers: { "x-next-page": page === 1 ? "2" : "" },
		});
	});
	const client = new GitLabClient(
		{ baseUrl: "https://gitlab.test", token: "fixture-token" },
		{ fetch: request },
	);
	const catalog = createGitLabRepositoryCatalog({ profiles: () => ["team"], client: () => client });
	const [first, second] = await Promise.all([catalog.list("team"), catalog.list("team")]);
	expect(first.map((repository) => repository.id)).toEqual([1, 2]);
	expect(second).toEqual(first);
	await catalog.list("team");
	expect(request).toHaveBeenCalledTimes(2);
	name = "renamed";
	expect((await catalog.list("team"))[0].path_with_namespace).toBe("team/original-1");
	expect((await catalog.refresh("team"))[0].path_with_namespace).toBe("team/renamed-1");
	expect((await catalog.list("team"))[0].path_with_namespace).toBe("team/renamed-1");
	expect(first[0].path_with_namespace).toBe("team/original-1");
	expect(request).toHaveBeenCalledTimes(4);
});

it("serves the last good catalog during a shared refresh and retains it after a failure", async () => {
	const f = fixture();
	await f.catalog.list("team");
	const pending = Promise.withResolvers<GitLabProject[]>();
	f.listProjects.mockReturnValueOnce(pending.promise);
	const first = f.catalog.refresh("team");
	const second = f.catalog.refresh("team");
	expect((await f.catalog.list("team"))[0].id).toBe(1);
	expect(f.listProjects).toHaveBeenCalledTimes(2);
	const failed = Promise.allSettled([first, second]);
	pending.reject(new Error("Repository scan unavailable"));
	expect((await failed).map((result) => result.status)).toEqual(["rejected", "rejected"]);
	expect((await f.catalog.list("team"))[0].id).toBe(1);
	f.listProjects.mockResolvedValueOnce([project(2)]);
	expect((await f.catalog.refresh("team"))[0].id).toBe(2);
	expect((await f.catalog.list("team"))[0].id).toBe(2);
	expect(f.listProjects).toHaveBeenCalledTimes(3);
});

it("retries a failed first scan and isolates catalogs by profile and installation", async () => {
	const f = fixture();
	f.listProjects.mockRejectedValueOnce(new Error("Repository scan unavailable"));
	await expect(f.catalog.list("team")).rejects.toThrow("Repository scan unavailable");
	expect((await f.catalog.list("team"))[0].id).toBe(1);
	f.listProjects.mockResolvedValueOnce([project(2)]);
	expect((await f.catalog.list("another-profile"))[0].id).toBe(2);
	expect((await f.catalog.list("team"))[0].id).toBe(1);
	f.integration.client = () => ({ ...f.client, baseUrl: "https://another-gitlab.test" });
	f.listProjects.mockResolvedValueOnce([project(3)]);
	expect((await f.catalog.list("team"))[0].id).toBe(3);
	expect(f.listProjects).toHaveBeenCalledTimes(4);
});

it("Settings discovery refreshes the same catalog exposed to mapping editors", async () => {
	const f = fixture();
	let discover: Parameters<ScopedSettingsResolver["registerDiscovery"]>[1] | undefined;
	const settings: ScopedSettingsResolver = {
		resolve() {
			throw new Error("Unused resolver");
		},
		discover() {
			throw new Error("Unused subject writer");
		},
		registerDiscovery(scope, read) {
			expect(scope).toBe("repository");
			discover = read;
		},
	};
	const capabilities = createCapabilityAccessor([
		{ token: scopedSettingsCapability, value: settings },
	]);
	setupGitLabIntegration({ ...createToolCollector().api, ...capabilities }, f.integration);
	const integration = capabilities.require(gitlabIntegration);
	if (Array.isArray(integration) || !integration.repositoryCatalog || !discover)
		throw new Error("Missing repository discovery or catalog");
	expect((await discover())[0].label).toBe("team/project-1");
	expect((await integration.repositoryCatalog.list("team"))[0].id).toBe(1);
	expect(f.listProjects).toHaveBeenCalledTimes(1);
	f.listProjects.mockResolvedValueOnce([project(2)]);
	expect((await discover())[0].label).toBe("team/project-2");
	expect((await integration.repositoryCatalog.list("team"))[0].id).toBe(2);
	expect(f.listProjects).toHaveBeenCalledTimes(2);
});

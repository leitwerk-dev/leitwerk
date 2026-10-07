import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProcessProject } from "@leitwerk-dev/domain";
import type {
	IntegrationToolExecutionContext,
	ProcessProjectRepoLike,
} from "@leitwerk-dev/process-sdk";
import { createInMemoryExternalWriteLog, createToolCollector } from "@leitwerk-dev/test-support";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { expect, it } from "vitest";
import { GitLabClient } from "./client.js";
import { registerGitLabDeliveryTools } from "./delivery-tools.js";
import { LocalGitLabAdapter } from "./testing.js";
import { registerGitLabTools } from "./tools.js";

it("does not acknowledge feedback authored by an ignored user", async () => {
	const request = async (url: URL | Request | string, init?: RequestInit) => {
		expect(String(url)).toContain("/discussions");
		expect(init?.method).toBe("GET");
		return Response.json([
			{
				id: "thread",
				notes: [
					{
						id: 42,
						body: "Quality gate",
						author: { username: "sonarqube" },
						created_at: "2026-10-06T10:00:00Z",
					},
				],
			},
		]);
	};
	const client = new GitLabClient(
		{ baseUrl: "https://forge.test", token: "test", ignoredCommentUsers: ["sonarqube"] },
		{ fetch: request },
	);
	const { api, tools } = createToolCollector();
	registerGitLabDeliveryTools(
		api,
		{ profiles: () => ["test"], client: () => client },
		{} as ProcessProjectRepoLike,
	);
	const project = {
		id: "project",
		instanceId: "process",
		key: "repo",
		metadata: { gitlab: { profile: "test", projectId: 7, iid: 1 } },
	} as ProcessProject;
	await expect(
		tools.get("gitlab_acknowledge_feedback")?.execute(
			{
				process: { id: "process" },
				project,
				projects: [project],
				signal: new AbortController().signal,
			} as IntegrationToolExecutionContext,
			{ noteId: 42 },
		),
	).rejects.toThrow("not actionable feedback");
});

it("recovers remote MR creation before local binding and preserves existing MR-bound tools", async ({
	onTestFinished,
}) => {
	const root = mkdtempSync(path.join(tmpdir(), "gitlab-delivery-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const git = new LocalGit(root);
	const bare = git.seed({ owner: "team", name: "repo" }).bare;
	git.run(bare, ["branch", "feature", "main"]);
	let adapter = new LocalGitLabAdapter(root);
	adapter.addProject("team/repo", bare);
	adapter.loseNextMergeRequestResponse = true;
	let project = {
		id: "project",
		instanceId: "process",
		key: "repo",
		workBranch: "feature",
		baseBranch: "main",
		metadata: { gitlab: { profile: "team", projectId: 1 } },
	} as ProcessProject;
	let failBinding = true;
	const projects: ProcessProjectRepoLike = {
		create() {
			throw new Error("unused");
		},
		getByInstanceAndKey: () => project,
		listByInstance: () => [project],
		update(_id, patch) {
			if (failBinding) {
				failBinding = false;
				throw new Error("Stopped before local binding");
			}
			project = { ...project, ...patch };
			return project;
		},
	};
	let writes = createInMemoryExternalWriteLog();
	const integration = { profiles: () => ["team"], client: () => adapter.client() };
	const collector = () => {
		const { api, tools } = createToolCollector(writes);
		registerGitLabDeliveryTools(api, integration, projects);
		registerGitLabTools(api, integration);
		return tools;
	};
	const ctx = () =>
		({
			process: { id: "process" },
			project,
			projects: [project],
			idempotencyKey: "attempt",
			signal: new AbortController().signal,
		}) as IntegrationToolExecutionContext;
	let tools = collector();
	const args = { projectKey: "repo", title: "Change", body: "Description" };
	await expect(tools.get("gitlab_get_changes")?.execute(ctx(), {})).rejects.toThrow(
		"merge request is required",
	);
	await expect(tools.get("gitlab_ensure_merge_request")?.execute(ctx(), args)).rejects.toThrow(
		"Stopped before local binding",
	);
	expect(adapter.state.mrs).toHaveLength(1);
	adapter = new LocalGitLabAdapter(root);
	writes = createInMemoryExternalWriteLog();
	tools = collector();
	await expect(
		tools.get("gitlab_ensure_merge_request")?.execute(ctx(), args),
	).resolves.toMatchObject({ iid: 1 });
	expect(project.metadata?.gitlab).toEqual({ profile: "team", projectId: 1, iid: 1 });
	expect(adapter.state.mrs).toHaveLength(1);
	await expect(tools.get("gitlab_get_changes")?.execute(ctx(), {})).resolves.toEqual([]);
	await tools.get("gitlab_ensure_merge_request")?.execute(ctx(), args);
	expect(adapter.state.mrs).toHaveLength(1);
	await expect(
		tools
			.get("gitlab_add_issue_comment")
			?.execute(ctx(), { issueNumber: 99, body: "Wrong issue", writeKey: "no" }),
	).rejects.toThrow("source issue");
});

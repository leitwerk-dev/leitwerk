import { createProjectFixture } from "@leitwerk-dev/test-support/fixtures";
import {
	createExtensionTestHarness,
	type ExtensionToolFixture,
} from "@leitwerk-dev/test-support/process";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ForgejoIntegration } from "./capability.js";
import type { ForgejoClient, ForgejoIssue } from "./client.js";
import { registerForgejoTools } from "./tools.js";

async function setup(client: Record<string, unknown>, enabled = true) {
	const integration = {
		profiles: () => ["primary"],
		client: () => client as unknown as ForgejoClient,
	} satisfies ForgejoIntegration;
	const projects = {
		update: vi.fn((_id: string, input: Record<string, unknown>) => ({ id: "project-1", ...input })),
	};
	const test = await createExtensionTestHarness({
		extensions: [
			{
				manifest: { id: "forgejo-tools-test", version: "1" },
				setupServer(api) {
					registerForgejoTools(
						api,
						integration,
						{ enabled, defaultLabels: ["created-by-leitwerk"] },
						projects as never,
					);
				},
			},
		],
	});
	onTestFinished(() => test.close());
	return { test, projects };
}

function fixture(destination: Record<string, unknown>): ExtensionToolFixture {
	return {
		id: "ticket-1",
		ticketDestination: {
			summary: { id: "primary.42", displayName: "team/repo", group: "primary · git.example.test" },
			data: destination,
		},
		invocationId: "stable-write-key",
	};
}

function issue(body: string): ForgejoIssue {
	return {
		number: 7,
		title: "Ticket",
		body,
		state: "open",
		html_url: "https://git.example.test/team/repo/issues/7",
		updated_at: "2026-08-23T00:00:00Z",
		user: { login: "leitwerk" },
		labels: [],
	};
}

describe("Forgejo server tools", () => {
	it.each([
		["forgejo_get_issue", "issueNumber", "getIssue", null],
		["forgejo_list_issue_comments", "issueNumber", "listIssueComments", null],
		["forgejo_get_pull_request", "pullRequestNumber", "getPullRequest", null],
		["forgejo_list_pull_request_feedback", "pullRequestNumber", "listPullRequestFeedback", null],
		["forgejo_add_issue_comment", "issueNumber", "addIssueComment", { body: "Review" }],
		[
			"forgejo_add_pull_request_comment",
			"pullRequestNumber",
			"addIssueComment",
			{ body: "Review" },
		],
		["forgejo_update_issue", "issueNumber", "updateIssue", { patch: { title: "Updated" } }],
		[
			"forgejo_update_pull_request",
			"pullRequestNumber",
			"updatePullRequest",
			{ patch: { title: "Updated" } },
		],
	] as const)("routes %s through the authorized project", async (name, numberName, method, payload) => {
		const remote = {
			body: "Review\n\n<!-- leitwerk-write:ticket-1:stable-write-key -->",
			title: "Before",
		};
		let created = false;
		const read = vi.fn(async () => {
			created = true;
			return payload ? remote : "result";
		});
		const { test } = await setup({
			listIssueComments: async () => (created ? [remote] : []),
			getIssue: async () => remote,
			getPullRequest: async () => remote,
			[method]: read,
		});
		const ctx = {
			...fixture({}),
			projects: [
				createProjectFixture({
					process: { id: "ticket-1" },
					key: "repo",
					metadata: { forgejo: { owner: "team", repo: "repo", profile: "primary" } },
				}),
			],
		};
		const tool = test.describeTools().find((t) => t.name === name);
		expect(tool?.parameters.required).toEqual([
			"projectKey",
			numberName,
			...Object.keys(payload ?? {}),
		]);
		const args = { [numberName]: 7, ...payload };
		const result = await test.callTool(name, args, ctx);
		expect(result).toEqual(payload ? ("patch" in payload ? { ok: true } : remote) : "result");
		expect(read).toHaveBeenCalledWith(
			"team",
			"repo",
			7,
			...(payload && "body" in payload ? [remote.body] : Object.values(payload ?? {})),
			expect.any(AbortSignal),
		);
		if (payload) {
			await test.callTool(name, args, ctx);
			expect(read).toHaveBeenCalledTimes(1);
		}
		for (const invalid of [0, -1, 1.5, NaN, "7"])
			await expect(test.callTool(name, { [numberName]: invalid }, ctx)).rejects.toThrow(
				"positive integer",
			);
	});

	it("resolves and durably pins project Git identity", async () => {
		const identity = {
			name: "Leitwerk Bot",
			email: "leitwerk-bot@noreply.git.example.test",
			provider: "forgejo" as const,
			profile: "primary",
			login: "leitwerk-bot",
		};
		const { test, projects } = await setup({ resolveGitIdentity: vi.fn(async () => identity) });
		const result = await test.callTool(
			"forgejo_resolve_git_identity",
			{ projectKey: "repo" },
			{
				...fixture({}),
				id: "process-1",
				params: { forgejoProfile: "primary" },
				projects: [
					createProjectFixture({
						id: "project-1",
						process: { id: "process-1" },
						key: "repo",
						metadata: { forgejo: { owner: "team", repo: "repo" } },
					}),
				],
			},
		);

		expect(result).toEqual(identity);
		expect(projects.update).toHaveBeenCalledWith("project-1", {
			metadata: {
				forgejo: { owner: "team", repo: "repo" },
				"leitwerk.gitIdentity": identity,
			},
		});
	});

	it("discovers valid repositories and snapshots labels", async () => {
		const client = {
			profile: { baseUrl: "https://git.example.test", token: "secret", botLogin: "leitwerk" },
			listRepositories: vi.fn(async () => [
				{
					id: 42,
					name: "repo",
					full_name: "team/repo",
					owner: { login: "team" },
					has_issues: true,
				},
				{
					id: 43,
					name: "archive",
					full_name: "team/archive",
					owner: { login: "team" },
					archived: true,
				},
			]),
			getRepositoryById: vi.fn(async () => ({
				id: 42,
				name: "repo",
				full_name: "team/repo",
				owner: { login: "team" },
				has_issues: true,
			})),
			listLabels: vi.fn(async () => [{ id: 3, name: "bug" }]),
		};
		const { test } = await setup(client);
		const destinations = await test.listToolDestinations("forgejo_create_issue", {
			id: "operator",
			kind: "user",
			provider: "oidc",
		});
		expect(destinations?.destinations).toHaveLength(1);
		expect(destinations?.destinations[0]).toMatchObject({
			id: "primary.42",
			displayName: "team/repo",
		});
		const snapshot = await test.resolveToolDestination("forgejo_create_issue", "primary.42", {
			id: "operator",
			kind: "user",
			provider: "oidc",
		});
		expect(snapshot?.agentContext).toContain("bug");
		expect(snapshot?.data).toEqual({
			profile: "primary",
			repositoryId: 42,
			owner: "team",
			repo: "repo",
			defaultLabels: ["created-by-leitwerk"],
		});
		if (!snapshot) throw new Error("destination snapshot missing");
		await expect(
			test.validateToolDestination("forgejo_create_issue", snapshot),
		).resolves.toBeUndefined();
		client.getRepositoryById.mockResolvedValueOnce({
			id: 42,
			name: "renamed",
			full_name: "team/renamed",
			owner: { login: "team" },
			has_issues: true,
		});
		await expect(test.validateToolDestination("forgejo_create_issue", snapshot)).rejects.toThrow(
			/changed/,
		);
	});

	it.each([
		false,
		true,
	])("creates defaults and returns one durable ticket receipt (lost label response: %s)", async (lostLabelResponse) => {
		let labels: Array<{ id: number; name: string }> = [];
		let issues: ForgejoIssue[] = [];
		const client = {
			profile: { baseUrl: "https://git.example.test", token: "secret", botLogin: "leitwerk" },
			listLabels: vi.fn(async () => labels),
			createLabel: vi.fn(async (_owner, _repo, name: string) => {
				const created = { id: 5, name };
				labels = [created];
				if (lostLabelResponse) throw new Error("Lost label response");
				return created;
			}),
			listIssues: vi.fn(async () => issues),
			createIssue: vi.fn(async (_owner, _repo, input: { body: string }) => {
				const created = issue(input.body);
				issues = [created];
				return created;
			}),
		};
		const { test } = await setup(client);
		const ctx = fixture({
			profile: "primary",
			repositoryId: 42,
			owner: "team",
			repo: "repo",
			defaultLabels: ["created-by-leitwerk"],
		});
		const receipt = await test.callTool(
			"forgejo_create_issue",
			{ title: "Ticket", body: "Description" },
			ctx,
		);
		expect(receipt).toMatchObject({
			externalId: "team/repo#7",
			url: "https://git.example.test/team/repo/issues/7",
		});
		expect(client.createIssue).toHaveBeenCalledWith(
			"team",
			"repo",
			expect.objectContaining({ labels: [5] }),
			expect.any(AbortSignal),
		);
		expect(issues[0]?.body).toContain("<!-- leitwerk-ticket-write:stable-write-key -->");
		expect(test.writeReceipts().length).toBe(2);

		const replay = await test.callTool(
			"forgejo_create_issue",
			{ title: "Ticket", body: "Description" },
			ctx,
		);
		expect(replay).toMatchObject({ externalId: "team/repo#7" });
		expect(client.createIssue).toHaveBeenCalledTimes(1);
		expect(client.createLabel).toHaveBeenCalledTimes(1);
	});
});

it("omits ticket registration when explicitly disabled", async () => {
	const { test } = await setup({}, false);
	const names = test.describeTools().map((tool) => tool.name);
	expect(names).not.toContain("forgejo_create_issue");
	expect(names).toContain("forgejo_ensure_pull_request");
});

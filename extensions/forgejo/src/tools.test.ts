import type { ExternalWriteLogRepoLike } from "@leitwerk-dev/external-writes";
import type {
	IntegrationToolDefinition,
	IntegrationToolExecutionContext,
	ServerExtensionAPI,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import type { ForgejoIntegration } from "./capability.js";
import type { ForgejoClient, ForgejoIssue } from "./client.js";
import { registerForgejoTools } from "./tools.js";

function setup(client: Record<string, unknown>) {
	const tools = new Map<string, IntegrationToolDefinition>();
	const api = {
		tool(definition: IntegrationToolDefinition) {
			tools.set(definition.name, definition);
		},
	} as ServerExtensionAPI;
	const integration = {
		profiles: () => ["primary"],
		client: () => client as unknown as ForgejoClient,
	} satisfies ForgejoIntegration;
	const written = new Set<string>();
	const writes: ExternalWriteLogRepoLike = {
		hasDedupKey: (key) => written.has(key),
		record: ({ dedupKey }) => written.add(dedupKey),
	};
	const projects = {
		update: vi.fn((_id: string, input: Record<string, unknown>) => ({ id: "project-1", ...input })),
	};
	registerForgejoTools(
		api,
		integration,
		writes,
		{ defaultLabels: ["created-by-leitwerk"] },
		projects as never,
	);
	return { tools, written, projects };
}

function context(destination: Record<string, unknown>): IntegrationToolExecutionContext {
	return {
		process: { id: "ticket-1" } as IntegrationToolExecutionContext["process"],
		projects: [],
		turn: { id: "turn-1" } as IntegrationToolExecutionContext["turn"],
		project: null,
		ticketDestination: {
			summary: {
				id: "primary.42",
				displayName: "team/repo",
				group: "primary · git.example.test",
			},
			data: destination,
		},
		idempotencyKey: "stable-write-key",
		signal: new AbortController().signal,
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
	it("resolves and durably pins project Git identity", async () => {
		const identity = {
			name: "Leitwerk Bot",
			email: "leitwerk-bot@noreply.git.example.test",
			provider: "forgejo" as const,
			profile: "primary",
			login: "leitwerk-bot",
		};
		const { tools, projects } = setup({ resolveGitIdentity: vi.fn(async () => identity) });
		const tool = tools.get("forgejo_resolve_git_identity");
		const result = await tool?.execute(
			{
				...context({}),
				process: {
					id: "process-1",
					paramsJson: JSON.stringify({ forgejoProfile: "primary" }),
				} as IntegrationToolExecutionContext["process"],
				project: {
					id: "project-1",
					instanceId: "process-1",
					metadata: { forgejo: { owner: "team", repo: "repo" } },
				} as IntegrationToolExecutionContext["project"],
			},
			{ projectKey: "repo" },
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
		const { tools } = setup(client);
		const tool = tools.get("forgejo_create_issue");
		const destinations = await tool?.capability?.destinations?.list({
			actor: { id: "operator", kind: "user", provider: "oidc" },
		});
		expect(destinations?.destinations).toHaveLength(1);
		expect(destinations?.destinations[0]).toMatchObject({
			id: "primary.42",
			displayName: "team/repo",
		});
		const snapshot = await tool?.capability?.destinations?.resolve({
			actor: { id: "operator", kind: "user", provider: "oidc" },
			destinationId: "primary.42",
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
		await expect(tool?.capability?.destinations?.validate(snapshot)).resolves.toBeUndefined();
		client.getRepositoryById.mockResolvedValueOnce({
			id: 42,
			name: "renamed",
			full_name: "team/renamed",
			owner: { login: "team" },
			has_issues: true,
		});
		await expect(tool?.capability?.destinations?.validate(snapshot)).rejects.toThrow(/changed/);
	});

	it("creates defaults and returns one durable ticket receipt without a process project", async () => {
		let labels: Array<{ id: number; name: string }> = [];
		let issues: ForgejoIssue[] = [];
		const client = {
			profile: { baseUrl: "https://git.example.test", token: "secret", botLogin: "leitwerk" },
			listLabels: vi.fn(async () => labels),
			createLabel: vi.fn(async (_owner, _repo, name: string) => {
				const created = { id: 5, name };
				labels = [created];
				return created;
			}),
			listIssues: vi.fn(async () => issues),
			createIssue: vi.fn(async (_owner, _repo, input: { body: string }) => {
				const created = issue(input.body);
				issues = [created];
				return created;
			}),
		};
		const { tools, written } = setup(client);
		const tool = tools.get("forgejo_create_issue");
		const ctx = context({
			profile: "primary",
			repositoryId: 42,
			owner: "team",
			repo: "repo",
			defaultLabels: ["created-by-leitwerk"],
		});
		const receipt = await tool?.execute(ctx, { title: "Ticket", body: "Description" });
		expect(receipt).toMatchObject({
			externalId: "team/repo#7",
			url: "https://git.example.test/team/repo/issues/7",
		});
		expect(client.createIssue).toHaveBeenCalledWith(
			"team",
			"repo",
			expect.objectContaining({ labels: [5] }),
			ctx.signal,
		);
		expect(issues[0]?.body).toContain("<!-- leitwerk-ticket-write:stable-write-key -->");
		expect(written.size).toBe(2);

		const replay = await tool?.execute(ctx, { title: "Ticket", body: "Description" });
		expect(replay).toMatchObject({ externalId: "team/repo#7" });
		expect(client.createIssue).toHaveBeenCalledTimes(1);
	});
});

it("omits ticket registration when explicitly disabled", () => {
	const tools = new Map<string, IntegrationToolDefinition>();
	registerForgejoTools(
		{ tool: (tool: IntegrationToolDefinition) => tools.set(tool.name, tool) } as ServerExtensionAPI,
		{
			profiles: () => [],
			client: () => {
				throw new Error("No provider call during registration");
			},
		},
		{ hasDedupKey: () => false, record: () => undefined },
		{ enabled: false, defaultLabels: [] },
	);
	expect(tools.has("forgejo_create_issue")).toBe(false);
	expect(tools.has("forgejo_ensure_pull_request")).toBe(true);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTestProcessInstance,
	createTestProcessProject,
	createTestWorkerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { resolveGitLabLaunchProject } from "@leitwerk-dev/gitlab";
import { LocalGitLabAdapter, setupGitLabIntegration } from "@leitwerk-dev/gitlab/testing";
import { type JiraIssue, setupJiraIntegration } from "@leitwerk-dev/jira";
import { LocalJiraSplitAdapter, registerJiraTools } from "@leitwerk-dev/jira/testing";
import {
	coreHostCapabilities,
	type IntegrationToolExecutionContext,
	type ProcessProjectRepoLike,
} from "@leitwerk-dev/process-sdk";
import { createTestServerSetupCapability, createToolCollector } from "@leitwerk-dev/test-support";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createJiraGitLabChange } from "./index.js";
import type { JiraGitLabParams, RepositoryBinding } from "./launch.js";

function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing fixture value");
	return value;
}

async function fixture(changes = [true, true]) {
	const root = mkdtempSync(join(tmpdir(), "jira-workflow-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	mkdirSync(workspaceRoot);
	const git = new LocalGit(root);
	const gitlab = new LocalGitLabAdapter(root);
	const client = gitlab.client();
	const jira = new LocalJiraSplitAdapter();
	const issue: JiraIssue = {
		id: "501",
		key: "APP-1",
		fields: {
			summary: "Change repositories",
			description: "Update the repositories",
			components: [],
			labels: ["use-leitwerk"],
			project: { id: "100", key: "APP", name: "App" },
			status: { id: "1", name: "Open", statusCategory: { key: "new" } },
		},
	};
	jira.seedIssue(issue);
	const instance = createTestProcessInstance({
		id: "process",
		processId: "jira_gitlab_change_process",
	});
	const projects = new Map<string, ReturnType<typeof createTestProcessProject>>();
	const repositories: RepositoryBinding[] = [];
	for (const [index, changed] of changes.entries()) {
		const key = `repo_${index + 1}`;
		const repository = gitlab.addProject(
			`team/${key}`,
			git.seed({ owner: "team", name: key }).bare,
		);
		const binding = await resolveGitLabLaunchProject(client, "team", repository, "feature", key);
		repositories.push({ ...binding.params, key, origin: "jira", sshProfile: "test" });
		projects.set(
			key,
			createTestProcessProject({
				...binding.project,
				id: key,
				instanceId: instance.id,
				metadata: {
					...binding.project.metadata,
					jira: { profile: "team", baseUrl: jira.baseUrl, issueId: issue.id },
				},
			}),
		);
		git.run(workspaceRoot, ["clone", repository.http_url_to_repo, key]);
		git.run(join(workspaceRoot, key), ["checkout", "-b", "feature"]);
		if (changed) writeFileSync(join(workspaceRoot, key, "README.md"), "# Changed\n");
	}
	const repoStore: ProcessProjectRepoLike = {
		create: () => {
			throw new Error("Unused");
		},
		listByInstance: () => [...projects.values()],
		getByInstanceAndKey: (_id, key) => projects.get(key) ?? null,
		update: (id, patch) => {
			const project = { ...required(projects.get(id)), ...patch };
			projects.set(id, project);
			return project;
		},
	};
	const collector = createToolCollector();
	const deps = createTestServerSetupCapability({
		projects: repoStore,
		serverBaseUrl: "https://leitwerk.test/app/",
	});
	const api = {
		...collector.api,
		provide() {},
		get: (token: unknown) =>
			token === coreHostCapabilities.serverSetup ? (deps as never) : undefined,
	};
	setupJiraIntegration(api, { profiles: () => ["team"], client: () => jira });
	setupGitLabIntegration(api, { profiles: () => ["team"], client: () => client });
	const { process } = createJiraGitLabChange({ docker: false });
	const params: JiraGitLabParams = {
		...repositories[0],
		origin: "jira",
		jiraProfile: "team",
		jiraBaseUrl: jira.baseUrl,
		issueId: issue.id,
		issueKey: issue.key,
		issueUrl: `${jira.baseUrl}/browse/${issue.key}`,
		prompt: required(issue.fields.description),
		issue,
		repositories,
		mappings: [],
	};
	let state = process.stateCodec.parse({
		finalization: {
			commitMessages: Object.fromEntries(
				repositories.map(({ key }) => [key, "feat: update repository"]),
			),
		},
	});
	const context = (turnId: string) => ({
		...createTestWorkerProcessContext({
			process: instance,
			projects: [...projects.values()],
			params,
			state,
			workspaceRoot,
		}),
		reportProgress() {},
		async callIntegrationTool(name: string, args: Record<string, unknown>) {
			const turn = required(process.turns.get(turnId)).definition;
			const allowed =
				turn.kind === "llm"
					? (turn.resolveIntegrationTools?.(params, state) ?? turn.integrationTools)
					: turn.kind === "automatic"
						? turn.integrationTools
						: [];
			if (!allowed?.includes(name)) throw new Error(`Undeclared tool ${name}`);
			const project = projects.get(String(args.projectKey)) ?? null;
			return required(collector.tools.get(name)).execute(
				{
					process: instance,
					projects: [...projects.values()],
					project,
					signal: new AbortController().signal,
				} as IntegrationToolExecutionContext,
				args,
			);
		},
	});
	return {
		jira,
		gitlab,
		client,
		process,
		resumeLegacyLinks() {
			jira.remoteLinks.clear();
			const issue = required(jira.issues.get("501"));
			issue.fields.status = { name: "In Progress", statusCategory: { key: "indeterminate" } };
			const legacy = createToolCollector();
			registerJiraTools(
				{ ...legacy.api, get: api.get },
				{ profiles: () => ["team"], client: () => jira },
			);
			for (const [name, tool] of legacy.tools) collector.tools.set(name, tool);
		},
		async plan() {
			const turn = required(process.turns.get("generate_plan")).definition;
			if (turn.kind !== "llm") throw new Error("Expected planning");
			return required(turn.prepare)(context("generate_plan"));
		},
		async deliver() {
			const turn = required(process.turns.get("deliver_change")).definition;
			if (turn.kind !== "automatic") throw new Error("Expected delivery");
			const result = await turn.run(context("deliver_change"));
			state = process.stateCodec.parse(result.params?.nextState);
			return result;
		},
		status: async () => (await jira.getIssue("501")).fields.status.name,
	};
}

// Two real repositories and retried publication need a bounded integration budget.
describe("Jira-backed change workflow", { timeout: 60_000 }, () => {
	it("keeps the ten-turn graph and links planning before work starts", async () => {
		const f = await fixture();
		expect([...f.process.turns.keys()]).toEqual([
			"generate_plan",
			"plan_decision",
			"implement",
			"simplify_implementation",
			"apply_simplification",
			"generate_commit_message",
			"deliver_change",
			"revise_from_merge_request_feedback",
			"repair_gitlab_pipeline",
			"ci_operator_action",
		]);
		await f.plan();
		await f.plan();
		expect(await f.status()).toBe("In Progress");
		expect(await f.jira.listRemoteLinks("501")).toMatchObject([
			{ object: { url: "https://leitwerk.test/app/processes/process" } },
		]);
		expect(await f.jira.listComments("501")).toEqual([]);
	});
	it("stays In Progress after partial publication, then links all MRs and enters review on retry", async () => {
		const f = await fixture();
		await f.plan();
		const create = f.client.createMergeRequest;
		let unavailable = true;
		vi.spyOn(f.client, "createMergeRequest").mockImplementation(async (id, input, signal) => {
			if (id === 2 && unavailable) throw new Error("Publication unavailable");
			return create(id, input, signal);
		});
		await expect(f.deliver()).rejects.toThrow("Publication unavailable");
		expect(f.gitlab.state.mrs).toHaveLength(1);
		expect(await f.status()).toBe("In Progress");
		unavailable = false;
		expect((await f.deliver()).outcome).toBe("awaiting");
		expect(f.gitlab.state.mrs).toHaveLength(2);
		expect(await f.status()).toBe("In Review");
		expect(await f.jira.listRemoteLinks("501")).toHaveLength(3);
		for (const mr of f.gitlab.state.mrs) {
			expect(mr.description).toContain("[APP-1](https://jira.test/context/browse/APP-1)");
			expect(mr.description).toContain(
				"[Leitwerk process](https://leitwerk.test/app/processes/process)",
			);
			expect(mr.description).toContain("<!-- leitwerk:gitlab:merge-request:process:");
		}
		await f.plan();
		expect(await f.status()).toBe("In Review");
		expect(await f.jira.listComments("501")).toEqual([]);
	});
	it("excludes unchanged repositories from the review boundary", async () => {
		const f = await fixture([true, false]);
		await f.plan();
		expect((await f.deliver()).outcome).toBe("awaiting");
		expect(f.gitlab.state.mrs).toHaveLength(1);
		expect(await f.status()).toBe("In Review");
	});
	it("adds native links when resuming a run that recorded comment-based MR links", async () => {
		const f = await fixture();
		await f.plan();
		await f.deliver();
		f.resumeLegacyLinks();
		await f.deliver();
		expect(await f.jira.listRemoteLinks("501")).toHaveLength(3);
		expect(await f.status()).toBe("In Review");
		expect(f.gitlab.state.mrs).toHaveLength(2);
		expect(await f.jira.listComments("501")).toEqual([]);
	});
	it("completes no-change runs without review or Jira comments", async () => {
		const f = await fixture([false, false]);
		await f.plan();
		expect((await f.deliver()).outcome).toBe("completed");
		expect(await f.status()).toBe("In Progress");
		expect(f.gitlab.state.mrs).toHaveLength(0);
		expect((await f.jira.getIssue("501")).fields.labels).toEqual([]);
		expect(await f.jira.listComments("501")).toEqual([]);
	});
	it("retries a failed review transition without duplicating MRs or links", async () => {
		const f = await fixture();
		await f.plan();
		const review = required(f.jira.transitions.pop());
		await expect(f.deliver()).rejects.toThrow("In Review");
		expect(await f.status()).toBe("In Progress");
		f.jira.transitions.push(review);
		await f.deliver();
		expect(await f.status()).toBe("In Review");
		expect(f.gitlab.state.mrs).toHaveLength(2);
		expect(await f.jira.listRemoteLinks("501")).toHaveLength(3);
	});
	it.each([
		"merged",
		"closed",
		"cancelled",
	])("preserves %s outcome/label behavior without Jira comments", async (outcome) => {
		const f = await fixture([true]);
		await f.plan();
		await f.deliver();
		if (outcome === "cancelled") required(f.jira.issues.get("501")).fields.labels = [];
		else f.gitlab.state.mrs[0].state = outcome;
		const result = await f.deliver();
		expect(result.outcome).toBe(outcome === "merged" ? "completed" : "aborted");
		expect((await f.jira.getIssue("501")).fields.labels).toEqual(
			outcome === "merged" ? ["leitwerk-done"] : [],
		);
		expect(await f.jira.listComments("501")).toEqual([]);
	});
});

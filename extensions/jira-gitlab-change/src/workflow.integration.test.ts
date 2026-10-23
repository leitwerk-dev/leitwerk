import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	patchPublicationState,
	readPublicationState,
} from "@leitwerk-dev/coding/repository-change-publication";
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
	const { process } = createJiraGitLabChange({
		docker: false,
		verificationOnMerge: true,
		verificationStatus: "Ready for Verification",
	});
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
		git,
		workspaceRoot,
		jira,
		gitlab,
		client,
		process,
		params,
		pushDeveloper(content: string, message: string) {
			const developer = join(root, "developer");
			mkdirSync(developer);
			git.run(developer, ["clone", "-b", "feature", params.repositories[0].repoLocator, "."]);
			writeFileSync(join(developer, "developer.txt"), content);
			git.run(developer, ["add", "."]);
			git.run(developer, ["commit", "-m", message]);
			git.run(developer, ["push", "origin", "feature"]);
			return git.run(developer, ["rev-parse", "HEAD"]);
		},
		async prompt(turnId: string) {
			const turn = required(process.turns.get(turnId)).definition;
			if (turn.kind !== "llm") throw new Error("Expected LLM turn");
			return turn.prompt({
				...context(turnId),
				turnResultMarkdownByProduct: { plan: "Approved plan" },
			});
		},
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
		publication: () => readPublicationState(state, "jiraGitLabChange:repo_1"),
		stageAdjustment() {
			state = patchPublicationState(state, "jiraGitLabChange:repo_1", {
				repairReason: "feedback",
				repairPending: false,
				delivery: { adjustment: { origin: "feedback", publishRequired: true } },
			});
		},
		stageTargetRepair(headSha: string) {
			const previous = readPublicationState(state, "jiraGitLabChange:repo_1");
			const p = params.repositories[0];
			state = patchPublicationState(state, "jiraGitLabChange:repo_1", {
				headSha,
				workBaselineSha: previous.workBaselineSha ?? previous.headSha,
				repairReason: "rebase",
				conflict: {
					owner: p.owner,
					repo: p.repo,
					prNumber: previous.prNumber ?? 1,
					headBranch: p.workBranch,
					baseBranch: p.baseBranch,
					headSha,
					baseSha: git.run(p.repoLocator, ["rev-parse", p.baseBranch]),
					url: previous.prUrl ?? "https://forge.example/mr/1",
				},
			});
		},
		async finishRevision(name: "changes_ready" | "no_changes") {
			const turn = required(process.turns.get("revise_from_merge_request_feedback")).definition;
			if (turn.kind !== "llm") throw new Error("Expected revision");
			const effect = await turn.outcomes?.[name]?.effect?.({
				ctx: context("revise_from_merge_request_feedback"),
				event: { params: { resultSummary: "Already correct" } },
			} as never);
			state = process.stateCodec.parse(effect?.state);
		},
		async prepareRevision() {
			const turn = required(process.turns.get("revise_from_merge_request_feedback")).definition;
			if (turn.kind !== "llm" || !turn.prepare) throw new Error("Expected revision preparation");
			return turn.prepare(context("revise_from_merge_request_feedback"));
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
	it("reconciles a developer push with retained local work and validates before publishing", async () => {
		const f = await fixture([true]);
		expect((await f.deliver()).outcome).toBe("awaiting");
		const local = join(f.workspaceRoot, "repo_1");
		f.pushDeveloper("developer change\n", "Developer change");
		writeFileSync(join(local, "local.txt"), "retained local change\n");
		f.stageAdjustment();
		expect((await f.deliver()).outcome).toBe("conflict_ready");
		expect(f.publication().reconciliationRequired).toBe(true);
		expect(readFileSync(join(local, "developer.txt"), "utf8")).toBe("developer change\n");
		expect(readFileSync(join(local, "local.txt"), "utf8")).toBe("retained local change\n");
		await f.prepareRevision();
		expect(await f.prompt("revise_from_merge_request_feedback")).toContain(
			"Validate the reconciled repository",
		);
		await f.finishRevision("no_changes");
		expect((await f.deliver()).outcome).toBe("awaiting");
		const bare = f.params.repositories[0].repoLocator;
		expect(f.git.run(bare, ["show", "feature:local.txt"])).toBe("retained local change");
		expect(f.git.run(bare, ["show", "feature:developer.txt"])).toBe("developer change");
		expect(f.git.run(bare, ["log", "--format=%s", "feature"])).not.toContain("checkpoint");
		expect(f.publication()).toMatchObject({
			reconciliationRequired: false,
			workBaselineSha: f.git.run(bare, ["rev-parse", "feature"]),
		});
	});

	it("rechecks a developer push made after revision preparation", async () => {
		const f = await fixture([true]);
		await f.deliver();
		const local = join(f.workspaceRoot, "repo_1");
		await f.prepareRevision();
		writeFileSync(join(local, "local.txt"), "agent work\n");
		f.pushDeveloper("concurrent work\n", "Concurrent push");
		await f.finishRevision("no_changes");
		expect(f.publication().delivery.feedbackResult).toBeUndefined();
		expect((await f.deliver()).outcome).toBe("conflict_ready");
		expect(readFileSync(join(local, "local.txt"), "utf8")).toBe("agent work\n");
		expect(readFileSync(join(local, "developer.txt"), "utf8")).toBe("concurrent work\n");
	});

	it("reconciles the source before attempting a target repair on a retained checkout", async () => {
		const f = await fixture([true]);
		await f.deliver();
		f.stageTargetRepair(f.pushDeveloper("source update\n", "Update source"));
		expect(await f.prepareRevision()).toMatchObject({ deferredRebase: true });
		await f.finishRevision("changes_ready");
		expect((await f.deliver()).outcome).toBe("conflict_ready");
		expect(f.publication()).toMatchObject({ reconciliationRequired: true, conflict: null });
		await f.prepareRevision();
		await f.finishRevision("changes_ready");
		expect((await f.deliver()).outcome).toBe("awaiting");
	});

	it.each([
		"generate_plan",
		"implement",
	])("uses Markdown in future %s turns of a retained run without changing its snapshot", async (turnId) => {
		const f = await fixture([false]);
		const source = "h2. Requirements\n\n* *Check* {{user_name}}\n\n{noformat}*literal*{noformat}";
		f.params.issue.fields.description = source;
		f.params.prompt = `APP-1: Change repositories\n\n${source}`;
		const captured = structuredClone(f.params);
		const prompt = await f.prompt(turnId);
		expect(prompt).toContain(
			"APP-1: Change repositories\n\n## Requirements\n\n- **Check** `user_name`",
		);
		expect(prompt).toContain("```\n*literal*\n```");
		expect(prompt).not.toContain("h2. Requirements");
		expect(f.params).toEqual(captured);
	});

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
	it("captures current question policy at planning preparation and retains it for recovery", async () => {
		const f = await fixture([false]);
		const turn = required(f.process.turns.get("generate_plan")).definition;
		if (turn.kind !== "llm") throw new Error("Expected planning");
		const ctx = createTestWorkerProcessContext({ params: f.params, state: {} });
		const issue = required(f.jira.issues.get("501"));
		issue.fields.labels.push("leitwerk-skip-plan-decision");
		const prepared = await f.plan();
		expect(prepared).toMatchObject({ skipPlanDecision: true });
		expect(turn.resolveAskQuestions?.({ ...ctx, prepared })).toBe(false);
		issue.fields.labels = ["use-leitwerk"];
		expect(turn.resolveAskQuestions?.({ ...ctx, prepared })).toBe(false);
		const refreshed = await f.plan();
		expect(turn.resolveAskQuestions?.({ ...ctx, prepared: refreshed })).toBe(true);
	});
	it("keeps questions available when the planning label read is unavailable", async () => {
		const f = await fixture([false]);
		vi.spyOn(f.jira, "getIssue").mockRejectedValueOnce(new Error("Jira unavailable"));
		const prepared = await f.plan();
		const turn = required(f.process.turns.get("generate_plan")).definition;
		if (turn.kind !== "llm") throw new Error("Expected planning");
		expect(prepared).toMatchObject({ skipPlanDecision: false });
		expect(
			turn.resolveAskQuestions?.({
				...createTestWorkerProcessContext({ params: f.params, state: {} }),
				prepared,
			}),
		).toBe(true);
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
		const review = required(f.jira.transitions.find((t) => t.to.name === "In Review"));
		f.jira.transitions = f.jira.transitions.filter((t) => t !== review);
		await expect(f.deliver()).rejects.toThrow("In Review");
		expect(await f.status()).toBe("In Progress");
		f.jira.transitions.push(review);
		await f.deliver();
		expect(await f.status()).toBe("In Review");
		expect(f.gitlab.state.mrs).toHaveLength(2);
		expect(await f.jira.listRemoteLinks("501")).toHaveLength(3);
	});
	it.each([
		{ changes: [true, true] },
		{ changes: [true, false] },
	])("enters verification only after all created MRs merge (changes: $changes)", async ({
		changes,
	}) => {
		const f = await fixture(changes);
		await f.plan();
		await f.deliver();
		const transition = vi.spyOn(f.jira, "transitionIssue");
		if (f.gitlab.state.mrs.length > 1) {
			f.gitlab.state.mrs[0].state = "merged";
			expect((await f.deliver()).outcome).toBe("awaiting");
			expect(await f.status()).toBe("In Review");
			expect((await f.jira.getIssue("501")).fields.labels).toEqual(["use-leitwerk"]);
		}
		for (const mr of f.gitlab.state.mrs) mr.state = "merged";
		expect((await f.deliver()).outcome).toBe("completed");
		expect(await f.status()).toBe("Ready for Verification");
		expect((await f.jira.getIssue("501")).fields.labels).toEqual(["leitwerk-done"]);
		await f.deliver();
		await f.plan();
		expect(await f.status()).toBe("Ready for Verification");
		expect(transition).toHaveBeenCalledTimes(1);
		expect(f.gitlab.state.mrs).toHaveLength(changes.filter(Boolean).length);
		expect(await f.jira.listRemoteLinks("501")).toHaveLength(f.gitlab.state.mrs.length + 1);
	});
	it("keeps partial completion In Review", async () => {
		const f = await fixture();
		await f.plan();
		await f.deliver();
		f.gitlab.state.mrs[0].state = "merged";
		f.gitlab.state.mrs[1].state = "closed";
		expect((await f.deliver()).outcome).toBe("completed");
		expect(await f.status()).toBe("In Review");
		expect((await f.jira.getIssue("501")).fields.labels).toEqual([]);
	});
	it("keeps completion labels pending until verification can be retried", async () => {
		const f = await fixture([true]);
		await f.plan();
		await f.deliver();
		f.gitlab.state.mrs[0].state = "merged";
		const verification = required(
			f.jira.transitions.find((t) => t.to.name === "Ready for Verification"),
		);
		f.jira.transitions = f.jira.transitions.filter((t) => t !== verification);
		await expect(f.deliver()).rejects.toThrow("Ready for Verification");
		expect(await f.status()).toBe("In Review");
		expect((await f.jira.getIssue("501")).fields.labels).toEqual(["use-leitwerk"]);
		f.jira.transitions.push(verification);
		expect((await f.deliver()).outcome).toBe("completed");
		expect(await f.status()).toBe("Ready for Verification");
		expect((await f.jira.getIssue("501")).fields.labels).toEqual(["leitwerk-done"]);
		expect(f.gitlab.state.mrs).toHaveLength(1);
		expect(await f.jira.listRemoteLinks("501")).toHaveLength(2);
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
		expect(await f.status()).toBe(outcome === "merged" ? "Ready for Verification" : "In Review");
		expect(await f.jira.listComments("501")).toEqual([]);
	});
});

import coding from "@leitwerk-dev/coding";
import {
	patchPublicationState,
	readPublicationState,
} from "@leitwerk-dev/coding/repository-change-publication";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { resolveGitLabLaunchProject } from "@leitwerk-dev/gitlab";
import { LocalGitLabAdapter, setupGitLabIntegration } from "@leitwerk-dev/gitlab/testing";
import jiraExtension, { type JiraIssue, setupJiraIntegration } from "@leitwerk-dev/jira";
import { LocalJiraSplitAdapter } from "@leitwerk-dev/jira/testing";
import { createAcceptedWorkerTurn } from "@leitwerk-dev/server/testing";
import { createPollingTestExtension } from "@leitwerk-dev/test-support";
import { createPersistentIntegrationFixture } from "@leitwerk-dev/test-support/integration";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createJiraGitLabChange } from "./index.js";
import type { JiraGitLabParams, RepositoryBinding } from "./launch.js";

async function fixture(changes = [true, true], verificationOnMerge = true) {
	const persistent = createPersistentIntegrationFixture("jira-maintenance-");
	onTestFinished(persistent.dispose);
	const { root } = persistent;
	const git = new LocalGit(root);
	const gitlab = new LocalGitLabAdapter(root);
	const jira = new LocalJiraSplitAdapter();
	const issue: JiraIssue = {
		id: "501",
		key: "APP-1",
		fields: {
			summary: "Change repositories",
			description: "Update repositories",
			components: [],
			labels: ["use-leitwerk"],
			project: { id: "100", key: "APP", name: "App" },
			status: { name: "In Review", statusCategory: { key: "indeterminate" } },
		},
	};
	jira.seedIssue(issue);
	let clock = Date.parse("2026-10-09T10:00:00Z");
	const provider = createPollingTestExtension(
		{ id: "gitlab", version: "1" },
		(api) =>
			setupGitLabIntegration(
				api,
				{
					profiles: () => ["team"],
					client: () => gitlab.client(),
				},
				{ now: () => clock },
			)?.maintenance,
		true,
	);
	const change = createJiraGitLabChange({ docker: false, verificationOnMerge });
	const catalog = await buildExtensionCatalogFromModules([
		coding,
		provider,
		{
			...jiraExtension,
			...createPollingTestExtension(
				{ id: "jira", version: "1" },
				(api) => setupJiraIntegration(api, { profiles: () => ["team"], client: () => jira }),
				true,
			),
		},
		change.extension,
	]);
	const repositories: RepositoryBinding[] = [];
	const projects = [];
	let state = change.process.stateCodec.parse({});
	for (const [index, changed] of changes.entries()) {
		const key = `repo_${index + 1}`;
		const bare = git.seed({ owner: "team", name: key }).bare;
		git.run(bare, ["branch", "feature", "main"]);
		const project = gitlab.addProject(`team/${key}`, bare);
		const binding = await resolveGitLabLaunchProject(
			gitlab.client(),
			"team",
			project,
			"feature",
			key,
		);
		const mr = changed ? gitlab.openMr(project, "feature") : null;
		repositories.push({ ...binding.params, key, origin: "jira" });
		projects.push({
			...binding.project,
			...(mr ? { externalId: String(mr.iid), externalUrl: mr.web_url } : {}),
			metadata: {
				...binding.project.metadata,
				gitlab: {
					origin: gitlab.baseUrl,
					profile: "team",
					projectId: project.id,
					...(mr ? { iid: mr.iid } : {}),
				},
				jira: { profile: "team", baseUrl: jira.baseUrl, issueId: issue.id },
			},
		});
		state = patchPublicationState(state, `jiraGitLabChange:${key}`, {
			noChanges: !changed,
			prNumber: mr?.iid ?? null,
			prUrl: mr?.web_url ?? null,
			headSha: mr?.sha ?? null,
			delivery: { stage: "awaiting" },
		});
	}
	const params: JiraGitLabParams = {
		...repositories[0],
		jiraProfile: "team",
		jiraBaseUrl: jira.baseUrl,
		issueId: issue.id,
		issueKey: issue.key,
		issueUrl: `${jira.baseUrl}/browse/${issue.key}`,
		prompt: "Update repositories",
		issue,
		repositories,
		mappings: [],
	};
	const open = () => persistent.open({ listen: false, extensionCatalog: catalog });
	let harness = await open();
	const instance = harness.ctx.deps.processes.create({
		processId: change.process.id,
		selectedTurnId: "deliver_change",
		lifecycleStatus: "waiting",
		paramsJson: JSON.stringify(params),
		stateJson: JSON.stringify(state),
	});
	for (const project of projects)
		harness.ctx.deps.projects.create({ ...project, instanceId: instance.id });
	const publicationTurn = createAcceptedWorkerTurn(harness.ctx, {
		id: `delivery_${instance.id}`,
		instanceId: instance.id,
		turnId: "deliver_change",
		turnType: "automatic",
		status: "succeeded",
		startedAt: new Date(clock).toISOString(),
		endedAt: new Date(clock).toISOString(),
	});
	return {
		jira,
		gitlab,
		provider,
		publicationTurn,
		process: () => harness.ctx.deps.processes.getById(instance.id),
		pushDeveloper(message = "Developer push") {
			const mr = gitlab.state.mrs[0];
			const bare = gitlab.state.projects[0].http_url_to_repo;
			const tree = git.run(bare, ["rev-parse", `${mr.sha}^{tree}`]);
			const head = git.run(bare, ["commit-tree", tree, "-p", mr.sha, "-m", message]);
			git.run(bare, ["update-ref", "refs/heads/feature", head]);
			mr.sha = head;
			return head;
		},
		beginWork() {
			harness.ctx.deps.processes.update(instance.id, {
				selectedTurnId: "revise_from_merge_request_feedback",
				lifecycleStatus: "running",
			});
			createAcceptedWorkerTurn(harness.ctx, {
				id: `working_${instance.id}`,
				instanceId: instance.id,
				turnId: "revise_from_merge_request_feedback",
				turnType: "llm",
				status: "running",
				startedAt: new Date(clock).toISOString(),
			});
		},
		stageFeedbackResult() {
			const process = harness.ctx.deps.processes.getById(instance.id);
			harness.ctx.deps.processes.update(instance.id, {
				stateJson: JSON.stringify(
					patchPublicationState(JSON.parse(process?.stateJson ?? "{}"), "jiraGitLabChange:repo_1", {
						feedbackIds: [{ kind: "inline", id: 10, discussionId: "review" }],
						repairReason: "feedback",
						delivery: { feedbackResult: { published: true, summary: "Previously addressed" } },
					}),
				),
			});
		},
		turns: () => harness.ctx.deps.turnRecords.listByInstance(instance.id),
		status: async () => (await jira.getIssue(issue.id)).fields.status.name,
		advance() {
			clock += 30_000;
		},
		async restart() {
			await persistent.close();
			harness = await open();
		},
	};
}

describe("Jira change completion maintenance", { timeout: 60_000 }, () => {
	it("dispatches pending feedback on a developer-updated head while retaining the old work baseline", async () => {
		const f = await fixture([true]);
		const mr = f.gitlab.state.mrs[0];
		const original = mr.sha;
		const head = f.pushDeveloper("Developer update");
		const key = `${mr.project_id}:${mr.iid}`;
		f.gitlab.state.feedback = {
			[key]: [
				{
					id: 10,
					discussionId: "review",
					author: "reviewer",
					body: "Please adjust the configuration",
					createdAt: "2026-10-09T09:00:00Z",
				},
			],
		};
		expect((await f.provider.poll()).errors).toEqual([]);
		expect(f.process()?.selectedTurnId).toBe("revise_from_merge_request_feedback");
		const current = readPublicationState(
			JSON.parse(f.process()?.stateJson ?? "{}"),
			"jiraGitLabChange:repo_1",
		);
		expect(current).toMatchObject({
			headSha: head,
			workBaselineSha: original,
			conversationCursor: 0,
			feedbackIds: [{ id: 10, discussionId: "review" }],
		});
		expect(f.gitlab.state.reactions?.[`${key}:10`]).toHaveLength(1);
	});

	it("adopts an idle remote head without allocating work or consuming feedback", async () => {
		const f = await fixture([true]);
		const mr = f.gitlab.state.mrs[0];
		const old = mr.sha;
		f.pushDeveloper("Developer update");
		expect((await f.provider.poll()).errors).toEqual([]);
		expect(f.process()).toMatchObject({
			selectedTurnId: "deliver_change",
			lifecycleStatus: "waiting",
			currentExecution: null,
		});
		expect(
			readPublicationState(JSON.parse(f.process()?.stateJson ?? "{}"), "jiraGitLabChange:repo_1"),
		).toMatchObject({ headSha: mr.sha, workBaselineSha: old });
	});

	it("records remote movement without mutating an active worker's state or execution", async () => {
		const f = await fixture([true]);
		f.beginWork();
		const before = f.process();
		const head = f.pushDeveloper();
		expect((await f.provider.poll()).errors).toEqual([]);
		expect(f.process()).toMatchObject({
			stateJson: before?.stateJson,
			selectedTurnId: before?.selectedTurnId,
			currentExecution: before?.currentExecution,
			lifecycleStatus: "running",
		});
		expect(f.process()?.metadata?.gitlabMaintenance).toMatchObject({
			repo_1: { observation: { mr: { sha: head } } },
		});
	});

	it("does not acknowledge an old feedback result against a changed source tree", async () => {
		const f = await fixture([true]);
		f.stageFeedbackResult();
		f.pushDeveloper();
		expect((await f.provider.poll()).errors).toEqual([]);
		expect(f.process()?.selectedTurnId).toBe("revise_from_merge_request_feedback");
		expect(
			readPublicationState(JSON.parse(f.process()?.stateJson ?? "{}"), "jiraGitLabChange:repo_1"),
		).toMatchObject({ conversationCursor: 0, delivery: { feedbackResult: null } });
		expect(f.gitlab.state.discussionNotes ?? {}).toEqual({});
	});

	it("finishes without a verification transition when it has not been enabled", async () => {
		const f = await fixture([true], false);
		const transition = vi.spyOn(f.jira, "transitionIssue");
		f.gitlab.state.mrs[0].state = "merged";
		expect((await f.provider.poll()).errors).toEqual([]);
		expect(f.process()?.lifecycleStatus).toBe("completed");
		expect(await f.status()).toBe("In Review");
		expect(transition).not.toHaveBeenCalled();
		expect((await f.jira.getIssue("501")).fields.labels).toEqual(["leitwerk-done"]);
	});

	it("maintenance waits for all MRs and reconciles verification once across a database restart", async () => {
		const f = await fixture([true, true, false]);
		await f.provider.poll();
		const transition = vi.spyOn(f.jira, "transitionIssue");
		f.gitlab.state.mrs[0].state = "merged";
		f.advance();
		expect((await f.provider.poll()).errors).toEqual([]);
		expect(await f.status()).toBe("In Review");
		expect(f.process()?.lifecycleStatus).toBe("waiting");
		f.gitlab.state.mrs[1].state = "merged";
		f.advance();
		expect((await f.provider.poll()).errors).toEqual([]);
		expect(f.process()).toMatchObject({
			lifecycleStatus: "completed",
			metadata: { gitlabMaintenanceCompleted: true },
		});
		expect(await f.status()).toBe("In Verification");
		expect((await f.jira.getIssue("501")).fields.labels).toEqual(["leitwerk-done"]);
		await f.restart();
		f.advance();
		expect((await f.provider.poll()).errors).toEqual([]);
		expect(transition).toHaveBeenCalledTimes(1);
		expect(f.turns()).toEqual([f.publicationTurn]);
	});

	it("maintenance retries failed verification after process closure and a database restart", async () => {
		const f = await fixture([true]);
		const verification = f.jira.transitions.find((t) => t.to.name === "In Verification");
		f.jira.transitions = f.jira.transitions.filter((t) => t !== verification);
		f.gitlab.state.mrs[0].state = "merged";
		expect((await f.provider.poll()).errors.join(" ")).toContain("In Verification");
		expect(f.process()?.lifecycleStatus).toBe("completed");
		expect(f.process()?.metadata?.gitlabMaintenanceCompleted).not.toBe(true);
		expect(await f.status()).toBe("In Review");
		expect((await f.jira.getIssue("501")).fields.labels).toEqual(["use-leitwerk"]);
		await f.restart();
		if (!verification) throw new Error("Verification fixture is missing");
		f.jira.transitions.push(verification);
		f.advance();
		expect((await f.provider.poll()).errors).toEqual([]);
		expect(f.process()?.metadata?.gitlabMaintenanceCompleted).toBe(true);
		expect(await f.status()).toBe("In Verification");
		expect((await f.jira.getIssue("501")).fields.labels).toEqual(["leitwerk-done"]);
		expect(f.turns()).toEqual([f.publicationTurn]);
	});

	it.each([
		"closed",
		"stopped",
		"deleted",
		"cancelled",
	])("maintenance skips verification for a merged MR alongside a %s MR", async (outcome) => {
		const f = await fixture();
		await f.provider.poll();
		f.gitlab.state.mrs[0].state = "merged";
		const other = f.gitlab.state.mrs[1];
		if (outcome === "closed") other.state = "closed";
		if (outcome === "stopped")
			await f.gitlab.client().updateMergeRequestLabels(other.project_id, other.iid, {
				remove_labels: "leitwerk-active",
			});
		if (outcome === "deleted") f.gitlab.state.mrs.pop();
		if (outcome === "cancelled") {
			const issue = f.jira.issues.get("501");
			if (!issue) throw new Error("Jira fixture is missing");
			issue.fields.labels = [];
		}
		f.advance();
		expect((await f.provider.poll()).errors).toEqual([]);
		expect(f.process()?.lifecycleStatus).toBe(
			["closed", "stopped"].includes(outcome) ? "completed" : "aborted",
		);
		expect(await f.status()).toBe("In Review");
		expect((await f.jira.getIssue("501")).fields.labels).not.toContain("leitwerk-done");
		expect(f.turns()).toEqual([f.publicationTurn]);
	});
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGitLabAdapter } from "@leitwerk-dev/gitlab/testing";
import {
	ensureEpicWiki,
	type JiraIssue,
	JiraRequestError,
	jiraEpicRevision,
} from "@leitwerk-dev/jira";
import { LocalJiraAdapter, registerJiraWikiTools } from "@leitwerk-dev/jira/testing";
import { createJiraGitLabLauncher } from "@leitwerk-dev/jira-gitlab-change";
import {
	createCapabilityAccessor,
	type IntegrationToolExecutionContext,
	type ScopedSettingsResolver,
	topicWikiCapability,
} from "@leitwerk-dev/process-sdk";
import { createTestDeps } from "@leitwerk-dev/server/testing";
import { createToolCollector } from "@leitwerk-dev/test-support";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { expect, it, onTestFinished } from "vitest";
import { initialSplitState, parseDraft, splitParamsCodec } from "./model.js";
import {
	componentMapping,
	launchSplit,
	parseLabels,
	registerSplitTools,
	type SplitServices,
} from "./services.js";

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "epic-split-"));
	let deps = createTestDeps({ sqlitePath: join(root, "state.sqlite") });
	onTestFinished(() => {
		deps.db.$client.close();
		rmSync(root, { recursive: true, force: true });
	});
	const git = new LocalGit(root);
	const gitlab = new LocalGitLabAdapter(root);
	for (const name of ["one", "two"])
		gitlab.addProject(
			`team/${name}`,
			git.seed({ owner: "team", name, files: { "README.md": "Old standard" } }).bare,
		);
	const jira = new LocalJiraAdapter();
	const epic: JiraIssue = {
		id: "10",
		key: "APP-10",
		fields: {
			summary: "Standardize readmes",
			description: "Use the shared template",
			issuetype: { id: "epic", name: "Epic" },
			project: { id: "100", key: "APP", name: "App" },
			components: [],
			labels: ["leitwerk-epic-split"],
			status: { statusCategory: { key: "new" } },
		},
	};
	jira.seedIssue(epic);
	const mappings = [1, 2].map((projectId) =>
		JSON.stringify({
			origin: gitlab.baseUrl,
			projectId,
			gitlabProfile: "team",
			sshProfile: "team",
		}),
	);
	const settings = {
		discover: (input: { identity: string }) => ({ ...input, id: input.identity }),
		resolve: () => ({ value: [...mappings], sources: [] }),
		registerDiscovery() {},
	} as unknown as ScopedSettingsResolver;
	const services: SplitServices = {
		jira: { profiles: () => ["team"], client: () => jira },
		gitlab: { profiles: () => ["team"], client: () => gitlab.client() },
		ssh: { profiles: () => ["team"], preflight: async () => ({ ok: true }) },
		settings,
		wiki: deps.topicWiki,
		serverBaseUrl: "https://leitwerk.test",
	};
	const launch = await launchSplit(services, {
		jiraProfile: "team",
		gitlabProfile: "team",
		sshProfile: "team",
		epic: epic.key,
		groups: "team",
	});
	const params = launch.params;
	const state = initialSplitState(params);
	state.epic = epic;
	state.epicRevision = jiraEpicRevision(epic);
	for (const repository of params.repositories) {
		state.drafts.push({
			...parseDraft({
				repositoryKey: repository.key,
				verdict: "applicable",
				reason: "Uses the old standard",
				evidence: "README.md has the old template",
				revision: (await gitlab.client().getBranch(repository.projectId, "main")).commit.id,
				summary: "Standardize README",
				description: "Replace the template. Acceptance: README uses the shared sections.",
				issueType: "Story",
			}),
			...(await componentMapping(services, params, repository)),
		});
	}
	state.approved = state.drafts.map((draft) => draft.repositoryKey);
	let process = deps.processes.create({
		processId: "jira_epic_split_process",
		paramsJson: JSON.stringify(params),
		stateJson: JSON.stringify(state),
		metadata: launch.metadata,
	});
	function tool(name: string, args = {}) {
		const collector = createToolCollector(deps.externalWrites);
		registerSplitTools(collector.api, services);
		return collector.tools.get(name)!.execute(
			{
				process: {
					...process,
					paramsJson: JSON.stringify(params),
					stateJson: JSON.stringify(state),
				},
				turn: { id: "turn", turnId: "publish_tickets" },
			} as IntegrationToolExecutionContext,
			args,
		);
	}
	return {
		root,
		git,
		gitlab,
		jira,
		epic,
		params,
		state,
		services,
		mappings,
		tool,
		process,
		replaceSource() {
			deps.processes.delete(process.id);
			process = deps.processes.create({
				processId: "jira_epic_split_process",
				paramsJson: JSON.stringify(params),
				stateJson: JSON.stringify(state),
				metadata: launch.metadata,
			});
		},
		restart() {
			deps.db.$client.close();
			deps = createTestDeps({ sqlitePath: join(root, "state.sqlite") });
			services.wiki = deps.topicWiki;
		},
	};
}

it("creates one untriggered ticket with components, exact routing, and shared epic membership", async () => {
	const test = await fixture();
	const result = (await test.tool("jira_split_publish", { repositoryKey: "repo_1" })) as {
		receipt: { id: string };
	};
	expect(test.jira.creations).toHaveLength(1);
	expect(test.jira.creations[0]).toMatchObject({
		components: [{ id: "200" }],
		customfield_100: "APP-10",
		issuetype: { id: "Story" },
	});
	expect(test.jira.creations[0].description).toContain(
		`https://leitwerk.test/wiki/${test.params.topicId}`,
	);
	expect((await test.jira.getIssue(result.receipt.id)).fields.labels).not.toContain("use-leitwerk");
	await test.tool("jira_split_publish", { repositoryKey: "repo_1" });
	expect(test.jira.creations).toHaveLength(1);
	await test.jira.updateLabels(result.receipt.id, [], ["use-leitwerk"]);
	const launcher = createJiraGitLabLauncher();
	launcher.configure(test.services);
	const child = await launcher.resolve({
		profile: "team",
		projects: ["100"],
		issue: await test.jira.getIssue(result.receipt.id),
	});
	expect(child.params.repositories.map((repository) => repository.projectId)).toEqual([1]);
	expect(child.params.wikiTopicId).toBe(test.params.topicId);
	const manual = { ...(await test.jira.getIssue(result.receipt.id)), id: "900", key: "APP-900" };
	test.jira.seedIssue(manual, test.epic.key);
	const manualLaunch = await launcher.resolve({
		profile: "team",
		projects: ["100"],
		issue: manual,
	});
	expect(manualLaunch.params.repositories.map((repository) => repository.projectId)).toEqual([
		1, 2,
	]);
	expect(manualLaunch.params.wikiTopicId).toBe(test.params.topicId);
	test.gitlab.state.projects[0].default_branch = "renamed";
	await expect(
		launcher.resolve({
			profile: "team",
			projects: ["100"],
			issue: await test.jira.getIssue(result.receipt.id),
		}),
	).rejects.toThrow("checkout binding changed");
	test.gitlab.state.projects[0].default_branch = "main";
	test.mappings.splice(0, 1);
	await expect(
		launcher.resolve({
			profile: "team",
			projects: ["100"],
			issue: await test.jira.getIssue(result.receipt.id),
		}),
	).rejects.toThrow("binding");
});

it("reconciles a lost POST response across restart and delayed search without duplicating tickets", async () => {
	const test = await fixture();
	test.jira.loseNextCreateResponse = true;
	test.jira.searchVisible = false;
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).rejects.toThrow(
		"Response lost",
	);
	test.restart();
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).rejects.toThrow(
		"uncertain",
	);
	expect(test.jira.creations).toHaveLength(1);
	test.jira.searchVisible = true;
	test.gitlab.state.projects[0].archived = true;
	test.jira.issues.get("10")!.fields.description = "Requirement changed after the POST";
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).resolves.toMatchObject(
		{ receipt: { key: "APP-1001" } },
	);
	expect(test.jira.creations).toHaveLength(1);
});

it("allows retry after an explicit rejection and never reapplies a consumed trigger", async () => {
	const test = await fixture();
	const create = test.jira.createIssue.bind(test.jira);
	test.jira.createIssue = async () => {
		throw new JiraRequestError(400);
	};
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).rejects.toThrow("400");
	test.jira.createIssue = create;
	test.state.labels = ["use-leitwerk", "migration"];
	const result = (await test.tool("jira_split_publish", { repositoryKey: "repo_1" })) as {
		receipt: { id: string };
	};
	expect((await test.jira.getIssue(result.receipt.id)).fields.labels).toContain("use-leitwerk");
	expect(test.jira.creations[0].labels).not.toContain("use-leitwerk");
	await test.jira.updateLabels(result.receipt.id, ["use-leitwerk"], []);
	test.replaceSource();
	test.restart();
	test.gitlab.state.projects[0].archived = true;
	await test.tool("jira_split_publish", { repositoryKey: "repo_1" });
	expect((await test.jira.getIssue(result.receipt.id)).fields.labels).not.toContain("use-leitwerk");
});

it("shares only the bound epic's evidence across processes and rejects deleted-entry replay", async () => {
	const test = await fixture();
	const store = test.services.wiki;
	const collector = createToolCollector();
	collector.api.get = createCapabilityAccessor([{ token: topicWikiCapability, value: store }]).get;
	registerJiraWikiTools(collector.api, test.services.jira);
	const call = (name: string, processId: string, args: Record<string, unknown>) =>
		collector.tools.get(name)!.execute(
			{
				process: { ...test.process, id: processId },
				turn: { id: `turn-${processId}` },
			} as IntegrationToolExecutionContext,
			args,
		);
	const input = {
		pageId: "shared-template",
		expectedRevision: 0,
		title: "README sections",
		markdown: "Use Setup and Validation",
		applicability: "Legacy README repositories",
		status: "observed",
		evidence: [
			{
				repository: "team/one",
				revision: "a".repeat(40),
				path: "README.md",
				observation: "Legacy format confirmed",
			},
		],
	};
	await call("wiki_share", "author", input);
	await call("wiki_share", "author", input);
	expect(store.history(test.params.topicId, input.pageId)).toHaveLength(1);
	await expect(call("wiki_read", "consumer", { pageId: input.pageId })).resolves.toMatchObject({
		page: { instanceId: "author", turnRecordId: "turn-author", markdown: input.markdown },
	});
	const other = ensureEpicWiki(store, test.jira, { ...test.epic, id: "20", key: "APP-20" });
	const current = store.readPage(test.params.topicId, input.pageId)!;
	store.savePage(
		{ ...current, id: "other-only", topicId: other.id, markdown: "Different epic" },
		0,
	);
	await expect(
		call("wiki_read", "consumer", { pageId: "other-only", topicId: other.id }),
	).resolves.toMatchObject({ page: null });
	await expect(call("wiki_share", "consumer", { ...input, evidence: [] })).rejects.toThrow(
		"require evidence",
	);
	store.deletePage(test.params.topicId, input.pageId, 1, "operator");
	await expect(call("wiki_read", "consumer", { pageId: input.pageId })).resolves.toMatchObject({
		page: null,
	});
	await expect(call("wiki_share", "author", input)).rejects.toThrow("deleted page");
});

it("blocks only unmapped drafts and rejects approval after mapping, epic, or repository drift", async () => {
	const test = await fixture();
	test.mappings.pop();
	const prepared = (await test.tool("jira_split_prepare")) as { drafts: typeof test.state.drafts };
	expect(prepared.drafts[0].blocked).toBeNull();
	expect(prepared.drafts[1].blocked).toContain("Map this repository");
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).resolves.toMatchObject(
		{ reviewRequired: expect.stringContaining("mapping changed") },
	);
	test.state.drafts = prepared.drafts;
	test.gitlab.state.projects[0].archived = true;
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).resolves.toMatchObject(
		{ reviewRequired: expect.stringContaining("archived") },
	);
	expect(
		((await test.tool("jira_split_prepare")) as { drafts: typeof test.state.drafts }).drafts[0]
			.blocked,
	).toContain("archived");
	test.jira.issues.get("10")!.fields.description = "Different requirement";
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).resolves.toMatchObject(
		{ reviewRequired: expect.stringContaining("Epic") },
	);
	expect(test.jira.creations).toHaveLength(0);
	test.jira.issues.get("10")!.fields.project.id = "999";
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).resolves.toMatchObject(
		{
			reviewRequired: expect.stringContaining("different Jira project"),
		},
	);
});

it("requires explicit approval and scope, preserves unavailable repository assessments, and forbids internal labels", async () => {
	const test = await fixture();
	test.state.approved = [];
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).rejects.toThrow(
		"approval",
	);
	await expect(
		launchSplit(test.services, {
			jiraProfile: "team",
			gitlabProfile: "team",
			sshProfile: "team",
			epic: "APP-10",
		}),
	).rejects.toThrow("explicit");
	test.params.repositories[0].baseBranch = "";
	test.params.repositories[0].repoLocator = "";
	expect(splitParamsCodec.parse(test.params)).toEqual(test.params);
	expect(() => parseLabels("leitwerk-done")).toThrow();
	expect(() => parseLabels(["use-leitwerk"])).toThrow("text");
	expect(() =>
		parseDraft({
			verdict: "applicable",
			repositoryKey: "repo_1",
			reason: "unknown",
			evidence: "unknown",
			issueType: "Story",
		}),
	).toThrow("inspected commit");
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGitLabAdapter } from "@leitwerk-dev/gitlab/testing";
import {
	ensureEpicWiki,
	ensureIssueWiki,
	type JiraIssue,
	JiraRequestError,
	jiraEpicRevision,
	jiraIssueExternalId,
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
	splitPublicationKey,
} from "./services.js";

async function fixture(
	sourceType = "Epic",
	configureJira: (jira: LocalJiraAdapter) => void = () => {},
) {
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
	configureJira(jira);
	const epic: JiraIssue = {
		id: "10",
		key: "APP-10",
		fields: {
			summary: "Standardize readmes",
			description: "Use the shared template",
			issuetype: { id: sourceType.toLowerCase(), name: sourceType, subtask: false },
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
				issueType: params.issueType,
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

it.each([
	"Story",
	"Task",
	"Bug",
	"Change Request",
])("splits a %s into native subtasks without Epic Link", async (sourceType) => {
	const test = await fixture(sourceType, (jira) => {
		jira.epicLinkField = null;
		jira.issueTypes[2].name = "Unteraufgabe";
	});
	expect(test.params.subtaskType).toEqual({ id: "10003", name: "Unteraufgabe" });
	const result = (await test.tool("jira_split_publish", { repositoryKey: "repo_1" })) as {
		receipt: { id: string };
	};
	expect(test.jira.creations[0]).toMatchObject({
		parent: { id: "10" },
		issuetype: { id: "10003" },
		components: [{ id: "200" }],
	});
	expect(test.jira.creations[0]).not.toHaveProperty("customfield_100");
	await test.jira.updateLabels(result.receipt.id, [], ["use-leitwerk"]);
	const launcher = createJiraGitLabLauncher();
	launcher.configure(test.services);
	const launch = await launcher.resolve({
		profile: "team",
		projects: ["100"],
		issue: await test.jira.getIssue(result.receipt.id),
	});
	expect(launch.params.repositories.map((repository) => repository.projectId)).toEqual([1]);
	expect(launch.params.wikiTopicId).toBe(test.params.topicId);
	test.restart();
	await test.tool("jira_split_publish", { repositoryKey: "repo_1" });
	expect(test.jira.creations).toHaveLength(1);
});

it("requires explicit selection for multiple subtask types and rejects unavailable types and invalid sources", async () => {
	const test = await fixture("Story");
	const input = {
		jiraProfile: "team",
		gitlabProfile: "team",
		sshProfile: "team",
		issue: "APP-10",
		groups: "team",
	};
	test.jira.issueTypes.push({ id: "10004", name: "Technical subtask", subtask: true, fields: {} });
	await expect(launchSplit(test.services, input)).rejects.toThrow("Select a subtask issue type ID");
	const selected = await launchSplit(test.services, { ...input, subtaskIssueType: "10004" });
	expect(selected.params.subtaskType).toEqual({ id: "10004", name: "Technical subtask" });
	await expect(launchSplit(test.services, { ...input, subtaskIssueType: "99999" })).rejects.toThrow(
		"Select a subtask issue type ID",
	);
	test.jira.issueTypes = test.jira.issueTypes.filter((type) => !type.subtask);
	await expect(launchSplit(test.services, input)).rejects.toThrow("no subtask issue types");
	test.jira.issues.get("10")!.fields.issuetype!.subtask = true;
	await expect(launchSplit(test.services, input)).rejects.toThrow("cannot have nested subtasks");
	test.jira.issues.get("10")!.fields.issuetype = undefined;
	await expect(launchSplit(test.services, input)).rejects.toThrow("metadata is unavailable");
	test.jira.issues.get("10")!.fields.issuetype = { id: "story", name: "Story" };
	test.jira.issues.get("10")!.fields.status.statusCategory.key = "done";
	await expect(launchSplit(test.services, input)).rejects.toThrow("open Jira issue");
});

it("blocks subtask type overrides, metadata removal, and source type drift before new writes", async () => {
	const test = await fixture("Story");
	test.state.drafts[0].issueType = "Task";
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).rejects.toThrow(
		"child relationship",
	);
	test.state.drafts[0].issueType = "Sub-task";
	const subtaskType = test.jira.issueTypes.pop()!;
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).rejects.toThrow(
		"no longer offers",
	);
	const prepared = (await test.tool("jira_split_prepare")) as { drafts: { blocked: string }[] };
	expect(prepared.drafts[0].blocked).toContain("no longer offers");
	test.jira.issueTypes.push(subtaskType);
	test.jira.issues.get("10")!.fields.issuetype = { id: "bug", name: "Bug" };
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).resolves.toEqual({
		reviewRequired: expect.stringContaining("type changed"),
	});
	expect(test.jira.creations).toHaveLength(0);
});

it.each([
	"leitwerk-issue-split",
	"leitwerk-epic-split",
])("rejects a persisted %s child label before publishing", async (label) => {
	const test = await fixture();
	test.state.labels = [label];
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).rejects.toThrow(
		"cannot be selected for child tickets",
	);
	expect(test.jira.creations).toHaveLength(0);
	expect(
		test.services.wiki.publication(splitPublicationKey(test.params, test.params.repositories[0])),
	).toBeNull();
});

it("keeps a story's sibling subtasks in its wiki and rejects changed parents", async () => {
	const test = await fixture("Story");
	const parentEpic: JiraIssue = { ...structuredClone(test.epic), id: "20", key: "APP-20" };
	parentEpic.fields.issuetype = { id: "epic", name: "Epic" };
	test.jira.seedIssue(parentEpic);
	test.jira.seedIssue(test.epic, parentEpic.key);
	const otherStory: JiraIssue = { ...structuredClone(test.epic), id: "11", key: "APP-11" };
	test.jira.seedIssue(otherStory, parentEpic.key);
	expect(ensureIssueWiki(test.services.wiki, test.jira, otherStory).id).not.toBe(
		test.params.topicId,
	);
	expect(ensureIssueWiki(test.services.wiki, test.jira, parentEpic).id).not.toBe(
		test.params.topicId,
	);
	const launcher = createJiraGitLabLauncher();
	launcher.configure(test.services);
	for (const repositoryKey of ["repo_1", "repo_2"]) {
		const result = (await test.tool("jira_split_publish", { repositoryKey })) as {
			receipt: { id: string };
		};
		await test.jira.updateLabels(result.receipt.id, [], ["use-leitwerk"]);
		const launch = await launcher.resolve({
			profile: "team",
			projects: ["100"],
			issue: await test.jira.getIssue(result.receipt.id),
		});
		expect(launch.params.wikiTopicId).toBe(test.params.topicId);
	}
	const manual = { ...(await test.jira.getIssue("1001")), id: "900", key: "APP-900" };
	test.jira.seedIssue(manual);
	const manualLaunch = await launcher.resolve({
		profile: "team",
		projects: ["100"],
		issue: manual,
	});
	expect(manualLaunch.params.wikiTopicId).toBe(test.params.topicId);
	expect(manualLaunch.params.repositories).toHaveLength(2);
	test.jira.issues.get("1001")!.fields.parent = { id: "11", key: "APP-11" };
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).rejects.toThrow(
		"source issue",
	);
	await expect(
		launcher.resolve({
			profile: "team",
			projects: ["100"],
			issue: await test.jira.getIssue("1001"),
		}),
	).rejects.toThrow("source issue binding changed");
});

it("reconciles legacy epic publication bindings and snapshots without another POST", async () => {
	const test = await fixture();
	const repository = test.params.repositories[0];
	const key = splitPublicationKey(test.params, repository);
	const created = await test.jira.createIssue({
		project: { id: "100" },
		issuetype: { id: "Story" },
		summary: "Existing child",
		description: "Published before upgrade",
		components: [{ id: "200" }],
		labels: [`leitwerk-split-${key}`],
		customfield_100: "APP-10",
	});
	test.services.wiki.reservePublication({
		key,
		topicId: test.params.topicId,
		binding: { ...repository, gitlabProfile: "team", sshProfile: "team", epicId: "10" },
		externalId: null,
		url: null,
	});
	test.services.wiki.finishPublication(
		key,
		jiraIssueExternalId(test.jira.baseUrl, created.id),
		`${test.jira.baseUrl}/browse/${created.key}`,
	);
	test.restart();
	expect(splitParamsCodec.parse(test.params)).toEqual(test.params);
	await expect(test.tool("jira_split_publish", { repositoryKey: "repo_1" })).resolves.toMatchObject(
		{ receipt: created },
	);
	expect(test.jira.creations).toHaveLength(1);
	await test.jira.updateLabels(created.id, [], ["use-leitwerk"]);
	const launcher = createJiraGitLabLauncher();
	launcher.configure(test.services);
	const launch = await launcher.resolve({
		profile: "team",
		projects: ["100"],
		issue: await test.jira.getIssue(created.id),
	});
	expect(launch.params.wikiTopicId).toBe(test.params.topicId);
});

it("prepares a fully published batch without requiring creation metadata", async () => {
	const test = await fixture();
	const result = (await test.tool("jira_split_publish", { repositoryKey: "repo_1" })) as {
		receipt: { id: string; key: string; url: string };
	};
	test.state.drafts = [{ ...test.state.drafts[0], receipt: result.receipt }];
	test.state.approved = [];
	test.jira.epicLinkField = null;
	await expect(test.tool("jira_split_prepare")).resolves.toMatchObject({
		drafts: [{ receipt: result.receipt }],
	});
});

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

it.each([
	"Epic",
	"Story",
])("reconciles a lost %s split POST across restart and delayed search without duplicating tickets", async (sourceType) => {
	const test = await fixture(sourceType);
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

it.each([
	"Epic",
	"Story",
])("retries a rejected %s split and never reapplies a consumed trigger", async (sourceType) => {
	const test = await fixture(sourceType);
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

it.each([
	"Epic",
	"Story",
])("shares only the bound %s's evidence and rejects deleted-entry replay", async (sourceType) => {
	const test = await fixture(sourceType);
	if (sourceType === "Epic")
		test.process.metadata = {
			wiki: {
				topicId: test.params.topicId,
				profile: "team",
				baseUrl: test.jira.baseUrl,
				epicId: "10",
			},
		};
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
	test.jira.issues.get("10")!.fields.description = "Changed requirement";
	await expect(call("wiki_read", "consumer", { pageId: input.pageId })).resolves.toMatchObject({
		page: { status: "needs_revalidation" },
	});
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
		{ reviewRequired: expect.stringContaining("Source issue") },
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

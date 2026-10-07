import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGitLabAdapter } from "@leitwerk-dev/gitlab/testing";
import {
	ensureIssueWiki,
	type JiraIssue,
	jiraIssueExternalId,
	jiraWikiSource,
} from "@leitwerk-dev/jira";
import { LocalJiraSplitAdapter } from "@leitwerk-dev/jira/testing";
import type {
	IntegrationToolExecutionContext,
	ScopedSettingsResolver,
} from "@leitwerk-dev/process-sdk";
import { createTestDeps } from "@leitwerk-dev/server/testing";
import { createToolCollector } from "@leitwerk-dev/test-support";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { createWikiIntegration } from "@leitwerk-dev/wiki/integration";
import { registerWikiTools } from "@leitwerk-dev/wiki/server";
import { expect, it, onTestFinished, vi } from "vitest";
import { createJiraGitLabChange } from "./index.js";
import { createJiraGitLabLauncher, jiraGitLabParamsCodec } from "./launch.js";
import { parseJiraModelLabels } from "./models.js";

function fixture(bindingPatch: Record<string, unknown> = {}, https = false) {
	const root = mkdtempSync(join(tmpdir(), "jira-retained-"));
	const sqlitePath = join(root, "state.sqlite");
	let db = createTestDeps({ sqlitePath });
	onTestFinished(() => {
		db.db.$client.close();
		rmSync(root, { recursive: true, force: true });
	});
	const git = new LocalGit(root);
	const gitlab = new LocalGitLabAdapter(root);
	for (const name of ["monitor", "other"])
		gitlab.addProject(`team/${name}`, git.seed({ owner: "team", name }).bare);
	const jira = new LocalJiraSplitAdapter();
	const parent: JiraIssue = {
		id: "10",
		key: "APP-10",
		fields: {
			issuetype: { id: "3", name: "Task" },
			project: { id: "100", key: "APP", name: "App" },
			summary: "Shared requirement",
			description: "Update services",
			labels: ["use-leitwer"],
			components: [],
			status: { statusCategory: { key: "new" } },
		},
	};
	const child: JiraIssue = {
		id: "11",
		key: "APP-11",
		fields: {
			...parent.fields,
			parent: { id: "10", key: "APP-10" },
			issuetype: { id: "5", name: "Sub-task", subtask: true },
			labels: ["use-leitwerk"],
			components: [{ id: "200", name: "Service" }],
		},
	};
	jira.issues.set(parent.id, parent);
	jira.issues.set(child.id, child);
	const topic = db.topicWiki.ensureTopic({
		key: JSON.stringify(["private.service-split", jira.baseUrl, parent.id]),
		title: parent.fields.summary,
		url: `${jira.baseUrl}/browse/${parent.key}`,
		sourceRevision: "legacy",
	});
	const receipt = {
		key: "private-split:monitor",
		topicId: topic.id,
		binding: {
			origin: gitlab.baseUrl,
			projectId: 1,
			gitlabProfile: "team",
			repository: "team/monitor",
			baseBranch: "main",
			sourceIssueId: parent.id,
			relationship: "subtask",
			...bindingPatch,
		},
		externalId: null,
		url: null,
	};
	db.publications.reservePublication(receipt);
	db.publications.finishPublication(
		receipt.key,
		jiraIssueExternalId(jira.baseUrl, child.id),
		`${jira.baseUrl}/browse/${child.key}`,
	);
	const mappings = [1, 2].map((projectId) =>
		JSON.stringify({
			origin: gitlab.baseUrl,
			projectId,
			gitlabProfile: "team",
			...(https ? {} : { sshProfile: "write" }),
		}),
	);
	const preflights: unknown[] = [];
	const localClient = gitlab.client();
	const projectMetadata = (project: Awaited<ReturnType<typeof localClient.getProject>>) =>
		https
			? {
					...project,
					http_url_to_repo: `${gitlab.baseUrl}/${project.path_with_namespace}.git`,
					ssh_url_to_repo: undefined,
				}
			: project;
	const client = {
		...localClient,
		getProject: async (id: number | string) => projectMetadata(await localClient.getProject(id)),
		listProjects: async () => (await localClient.listProjects()).map(projectMetadata),
		searchProjects: async (search: string) =>
			(await localClient.searchProjects(search)).map(projectMetadata),
		preflightRepository: async (projectId: number, baseBranch: string, workBranch: string) => {
			preflights.push({ projectId, baseBranch, workBranch });
			await localClient.preflightRepository(projectId, baseBranch, workBranch);
		},
	};
	const services = {
		jira: { profiles: () => ["team"], client: () => jira },
		gitlab: { profiles: () => ["team"], client: () => client },
		ssh: https
			? undefined
			: {
					profiles: () => ["write"],
					preflight: async (input: unknown) => {
						preflights.push(input);
						return { ok: true as const };
					},
				},
		settings: {
			discover: (input: { identity: string }) => ({ ...input, id: input.identity }),
			resolve: () => ({ value: [...mappings], sources: [] }),
		} as unknown as ScopedSettingsResolver,
		wiki: db.topicWiki,
		publications: db.publications,
	};
	const launcher = createJiraGitLabLauncher();
	launcher.configure(services);
	const event = { profile: "team", projects: ["100"], issue: child };
	return {
		jira,
		gitlab,
		parent,
		child,
		topic,
		mappings,
		launcher,
		event,
		services,
		preflights,
		receipt: () => db.publications.publication(receipt.key),
		resolve: () => launcher.resolve(event),
		restart() {
			db.db.$client.close();
			db = createTestDeps({ sqlitePath });
			services.wiki = db.topicWiki;
			services.publications = db.publications;
		},
	};
}

it("captures the beta trigger and model selection without changing the issue identity", async () => {
	const f = fixture({}, true);
	const original = await f.resolve();
	f.child.fields.labels = ["use-leitwerk-beta", "leitwerk-model-sol"];
	f.launcher.configure({ ...f.services, modelLabels: { "leitwerk-model-sol": "sol-medium" } });
	const event = { ...f.event, triggerLabel: "use-leitwerk-beta" };
	const launch = await f.launcher.resolve(event, {
		modelProfiles: [
			{ id: "sol-medium", provider: "openai", modelId: "gpt-6.1-sol", thinkingLevel: "medium" },
		],
	});
	expect(launch.externalId).toBe(original.externalId);
	expect(launch.defaultModelProfileId).toBe("sol-medium");
	expect(launch.params).toMatchObject({
		jiraTriggerLabel: "use-leitwerk-beta",
		modelSelection: { label: "leitwerk-model-sol", profileId: "sol-medium" },
	});
	expect(launch.projects?.[0].metadata?.jira).toMatchObject({ triggerLabel: "use-leitwerk-beta" });
	await expect(f.launcher.resolve(event, { modelProfiles: [] })).rejects.toThrow("unavailable");
	await expect(f.resolve()).rejects.toThrow("no longer eligible");
	f.child.fields.labels.push("leitwerk-model-astra");
	await expect(f.launcher.resolve(event)).rejects.toThrow("only one");
	f.child.fields.labels = ["use-leitwerk-beta", "leitwerk-model-typo"];
	await expect(f.launcher.resolve(event)).rejects.toThrow("Unknown Jira model label");
	f.child.fields.labels = ["use-leitwerk-beta", "leitwerk-model-sol"];
	expect((await f.launcher.resolve(event)).defaultModelProfileId).toBe("sol-medium");
	f.child.fields.labels = ["use-leitwerk-beta"];
	const eligibility = f.launcher
		.checks(event, launch)
		.find((check) => check.id === "jira_eligibility");
	if (!eligibility) throw new Error("Missing eligibility check");
	await expect(eligibility.run({} as never)).rejects.toThrow("changed before admission");
});

it("validates configured model labels and leaves unlabelled runs on normal defaults", async () => {
	expect(parseJiraModelLabels(undefined)).toEqual({});
	expect(() => parseJiraModelLabels({ model_labels: { "other-label": "sol" } })).toThrow(
		"model_labels",
	);
	expect(() => parseJiraModelLabels({ model_labels: { "leitwerk-model-sol": " " } })).toThrow(
		"model_labels",
	);
	expect((await fixture({}, true).resolve()).defaultModelProfileId).toBeUndefined();
});

it("admits unchanged issues when Jira plugin and viewing metadata change between reads", async () => {
	const f = fixture({}, true);
	Object.assign(f.child.fields, {
		updated: "2026-10-05T20:00:00.000Z",
		lastViewed: "2026-10-05T21:00:00.000Z",
		customfield_11600: "SummaryBean@first",
	});
	const launch = await f.resolve();
	const fresh = structuredClone(f.child);
	Object.assign(fresh.fields, {
		lastViewed: "2026-10-05T22:00:00.000Z",
		customfield_11600: "SummaryBean@second",
	});
	f.jira.issues.set(fresh.id, fresh);
	const check = f.launcher.checks(f.event, launch).find((check) => check.id === "jira_eligibility");
	if (!check) throw new Error("Missing eligibility check");
	await expect(check.run({} as never)).resolves.toBeUndefined();
});

it.each([
	{ summary: "Changed just before admission" },
	{ description: "A changed requirement" },
	{ updated: "2026-10-05T22:00:00.000Z" },
	{ labels: ["use-leitwerk", "leitwerk-skip-plan-decision"] },
])("rejects a changed issue at admission: %j", async (fields) => {
	const f = fixture({}, true);
	const launch = await f.resolve();
	const fresh = structuredClone(f.child);
	Object.assign(fresh.fields, fields);
	f.jira.issues.set(fresh.id, fresh);
	const check = f.launcher.checks(f.event, launch).find((check) => check.id === "jira_eligibility");
	if (!check) throw new Error("Missing eligibility check");
	await expect(check.run({} as never)).rejects.toThrow("changed before admission");
});

it("fills missing checkout credentials from the exact mapping and preserves receipts and wiki history across restart", async () => {
	const f = fixture();
	const receipt = f.receipt();
	const page = f.services.wiki.savePage(
		{
			id: "solution",
			topicId: f.topic.id,
			title: "Shared solution",
			markdown: "Retained evidence",
			applicability: "Monitor services",
			status: "observed",
			evidence: [],
			links: [],
			sourceRevision: f.topic.sourceRevision,
			instanceId: "split",
			turnRecordId: "assessment",
		},
		0,
	);
	const first = await f.resolve();
	expect(first.params.repositories).toHaveLength(1);
	expect(first.params.repositories[0]).toMatchObject({
		projectId: 1,
		sshProfile: "write",
		repoLocator: f.gitlab.state.projects[0].ssh_url_to_repo,
		baseBranch: "main",
	});
	expect(first.params.wikiTopicId).toBe(f.topic.id);
	for (const check of f.launcher.checks(f.event, first))
		await check.run({ signal: new AbortController().signal, logger: { warn() {} } } as never);
	expect(f.preflights).toEqual([
		expect.objectContaining({ credentialRef: "write", requireWrite: true }),
	]);
	f.restart();
	expect((await f.resolve()).params).toEqual(first.params);
	expect(f.receipt()).toEqual(receipt);
	expect(f.services.wiki.listTopics()).toHaveLength(1);
	expect(f.services.wiki.history(f.topic.id, page.id)).toEqual([page]);
	const collector = createToolCollector();
	const wiki = createWikiIntegration(f.services.wiki);
	wiki.registerProcessSource("jira_gitlab_change_process", jiraWikiSource(wiki, f.services.jira));
	registerWikiTools(collector.api, wiki);
	const result = await collector.tools.get("wiki_read")!.execute(
		{
			process: { id: "change", processId: "jira_gitlab_change_process", metadata: first.metadata },
			turn: { id: "plan" },
		} as IntegrationToolExecutionContext,
		{ pageId: page.id },
	);
	expect(result).toMatchObject({ page: { markdown: page.markdown, instanceId: "split" } });
});

it.each([
	{ sshProfile: "different" },
	{ gitlabProfile: "different" },
	{ projectId: 999 },
	{ origin: "https://another.test" },
	{ repoLocator: "git@other.test:wrong/repo.git" },
	{ repository: "team/renamed" },
	{ baseBranch: "release" },
	{ workBranch: "other-branch" },
	{ sourceIssueId: "999" },
	{ relationship: "epic" },
])("rejects retained binding drift %j", async (patch) => {
	await expect(fixture(patch).resolve()).rejects.toThrow(/binding/);
});

it("requires a matching mapping, rejects conflicting target credentials, and ignores unrelated repository conflicts", async () => {
	const f = fixture();
	const target = f.mappings.shift()!;
	await expect(f.resolve()).rejects.toThrow(/binding/);
	f.mappings.push(target, JSON.stringify({ ...JSON.parse(target), sshProfile: "different" }));
	await expect(f.resolve()).rejects.toThrow("Conflicting profiles");
	f.mappings.pop();
	f.mappings.push(JSON.stringify({ ...JSON.parse(f.mappings[0]), sshProfile: "different" }));
	expect((await f.resolve()).params.repositories).toHaveLength(1);
	f.child.fields.parent = { id: "20", key: "APP-20" };
	await expect(f.resolve()).rejects.toThrow("source issue binding changed");
});

it("rejects a retained wiki from another issue or installation, including context path, without creating a replacement", () => {
	const f = fixture();
	for (const [baseUrl, id] of [
		[f.jira.baseUrl, "other"],
		["https://jira.test/elsewhere", f.parent.id],
	]) {
		const foreign = f.services.wiki.ensureTopic({
			...f.topic,
			key: JSON.stringify(["private.service-split", baseUrl, id]),
		});
		expect(() => ensureIssueWiki(f.services.wiki, f.jira, f.parent, foreign.id)).toThrow(
			"binding mismatch",
		);
	}
	expect(() => ensureIssueWiki(f.services.wiki, f.jira, f.parent, "missing")).toThrow(
		"binding mismatch",
	);
	expect(f.services.wiki.listTopics()).toHaveLength(3);
});

it("ordinary tickets use a deduplicated component union and reject inactive, empty or conflicting selections", async () => {
	const f = fixture();
	f.child.id = "12";
	f.jira.issues.set("12", f.child);
	f.mappings.push(f.mappings[0]);
	expect((await f.resolve()).params.repositories.map((repo) => repo.projectId)).toEqual([1, 2]);
	f.gitlab.state.projects[0].archived = true;
	await expect(f.resolve()).rejects.toThrow("must be active");
	f.gitlab.state.projects[0].archived = false;
	f.mappings.push(JSON.stringify({ ...JSON.parse(f.mappings[0]), gitlabProfile: "other" }));
	await expect(f.resolve()).rejects.toThrow("Conflicting profiles");
	f.child.fields.components = [];
	await expect(f.resolve()).rejects.toThrow("No repositories mapped");
});

it("keeps saved repository selections discoverable when they do not match the search", async () => {
	const f = fixture({}, true);
	const choices = await f.launcher.mapping.choices?.(
		{},
		{ search: "other", values: [f.mappings[0]] },
	);
	expect(choices?.map((choice) => choice.value)).toEqual([f.mappings[1], f.mappings[0]]);
});

it("searches only on demand and caches queries across components while admission reads live metadata", async () => {
	const f = fixture({}, true);
	const listProjects = vi.spyOn(f.services.gitlab.client(), "listProjects");
	const searchProjects = vi.spyOn(f.services.gitlab.client(), "searchProjects");
	const getProject = vi.spyOn(f.services.gitlab.client(), "getProject");
	const choices = f.launcher.mapping.choices;
	if (!choices) throw new Error("Missing repository choices");
	expect(await choices({})).toEqual([]);
	expect(await choices({}, { search: " m " })).toEqual([]);
	expect(searchProjects).not.toHaveBeenCalled();
	await choices({ "jira.component": "first" }, { search: "monitor" });
	await choices({ "jira.component": "second" }, { search: "other", values: [f.mappings[0]] });
	f.launcher.configure({ ...f.services });
	await choices({ "jira.component": "first" }, { search: " MONITOR " });
	expect(searchProjects).toHaveBeenCalledTimes(2);
	expect(listProjects).not.toHaveBeenCalled();
	expect(getProject).not.toHaveBeenCalled();
	await f.resolve();
	expect(getProject).toHaveBeenCalled();
});

it("admits a retained split over HTTPS without an SSH provider and pins only credential references", async () => {
	const f = fixture({}, true);
	const choices = await f.launcher.mapping.choices?.({}, { search: "team" });
	expect(choices).toHaveLength(2);
	expect(choices?.every((choice) => choice.label.endsWith("/ HTTPS"))).toBe(true);
	expect(choices?.map((choice) => choice.value)).toEqual(f.mappings);
	const launch = await f.resolve();
	const repo = launch.params.repositories[0];
	expect(repo).toMatchObject({ projectId: 1, repoLocator: "https://gitlab.test/team/monitor.git" });
	expect(repo.sshProfile).toBeUndefined();
	expect(jiraGitLabParamsCodec.parse(JSON.parse(JSON.stringify(launch.params)))).toEqual(
		JSON.parse(JSON.stringify(launch.params)),
	);
	for (const check of f.launcher.checks(f.event, launch))
		await check.run({ signal: new AbortController().signal } as never);
	expect(f.preflights).toEqual([{ projectId: 1, baseBranch: "main", workBranch: repo.workBranch }]);
	const { process } = createJiraGitLabChange({ docker: false });
	expect(process.repositoryCredentials?.({ params: launch.params, projects: [] })).toEqual([
		{ projectKey: "repo_1", kind: "git_https", credentialRef: "gitlab:team" },
	]);
	const legacy = await fixture().resolve();
	expect(process.repositoryCredentials?.({ params: legacy.params, projects: [] })).toEqual([
		{ projectKey: "repo_1", kind: "git_ssh", credentialRef: "write" },
	]);
	expect(f.receipt()?.binding).not.toHaveProperty("repoLocator");
	f.restart();
	expect((await f.resolve()).params).toEqual(launch.params);
});

it("retries HTTPS admission failure and rejects clone drift or changing a retained SSH selection", async () => {
	const f = fixture({}, true);
	const launch = await f.resolve();
	const client = f.services.gitlab.client();
	const preflight = client.preflightRepository;
	client.preflightRepository = async () => {
		throw new Error("Write access denied");
	};
	const check = f.launcher.checks(f.event, launch)[0];
	const context = { signal: new AbortController().signal } as never;
	await expect(check.run(context)).rejects.toThrow("Write access denied");
	client.preflightRepository = preflight;
	await check.run(context);
	const getProject = client.getProject;
	client.getProject = async (id) => ({
		...(await getProject(id)),
		http_url_to_repo: "https://gitlab.test/team/moved.git",
	});
	await expect(check.run(context)).rejects.toThrow("Repository changed");
	await expect(fixture({ sshProfile: "write" }, true).resolve()).rejects.toThrow(/binding/);
});

it.each([
	"https://other.test/team/monitor.git",
	"https://oauth2:secret@gitlab.test/team/monitor.git",
	"http://gitlab.test/team/monitor.git",
])("rejects an unsafe HTTPS checkout URL %s", async (url) => {
	const f = fixture({}, true);
	const client = f.services.gitlab.client();
	const getProject = client.getProject;
	client.getProject = async (id) => ({ ...(await getProject(id)), http_url_to_repo: url });
	await expect(f.resolve()).rejects.toThrow(/origin|HTTPS/);
});

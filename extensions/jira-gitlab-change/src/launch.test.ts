import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGitLabAdapter } from "@leitwerk-dev/gitlab/testing";
import { ensureIssueWiki, type JiraIssue, jiraIssueExternalId } from "@leitwerk-dev/jira";
import { LocalJiraSplitAdapter, registerJiraWikiTools } from "@leitwerk-dev/jira/testing";
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
import { createJiraGitLabLauncher } from "./launch.js";

function fixture(bindingPatch: Record<string, unknown> = {}) {
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
	db.topicWiki.reservePublication(receipt);
	db.topicWiki.finishPublication(
		receipt.key,
		jiraIssueExternalId(jira.baseUrl, child.id),
		`${jira.baseUrl}/browse/${child.key}`,
	);
	const mappings = [1, 2].map((projectId) =>
		JSON.stringify({
			origin: gitlab.baseUrl,
			projectId,
			gitlabProfile: "team",
			sshProfile: "write",
		}),
	);
	const preflights: unknown[] = [];
	const services = {
		jira: { profiles: () => ["team"], client: () => jira },
		gitlab: { profiles: () => ["team"], client: () => gitlab.client() },
		ssh: {
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
		receipt: () => db.topicWiki.publication(receipt.key),
		resolve: () => launcher.resolve(event),
		restart() {
			db.db.$client.close();
			db = createTestDeps({ sqlitePath });
			services.wiki = db.topicWiki;
		},
	};
}

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
	collector.api.get = createCapabilityAccessor([
		{ token: topicWikiCapability, value: f.services.wiki },
	]).get;
	registerJiraWikiTools(collector.api, f.services.jira);
	const result = await collector.tools.get("wiki_read")!.execute(
		{
			process: { id: "change", metadata: first.metadata },
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

it("ordinary tickets use a deduplicated component union and reject empty or conflicting selections", async () => {
	const f = fixture();
	f.child.id = "12";
	f.jira.issues.set("12", f.child);
	f.mappings.push(f.mappings[0]);
	expect((await f.resolve()).params.repositories.map((repo) => repo.projectId)).toEqual([1, 2]);
	f.mappings.push(JSON.stringify({ ...JSON.parse(f.mappings[0]), gitlabProfile: "other" }));
	await expect(f.resolve()).rejects.toThrow("Conflicting profiles");
	f.child.fields.components = [];
	await expect(f.resolve()).rejects.toThrow("No repositories mapped");
});

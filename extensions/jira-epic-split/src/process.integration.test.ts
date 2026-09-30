import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingsSubject, WikiPage, WikiTopic } from "@leitwerk-dev/domain";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import { LocalGitLabAdapter, setupGitLabIntegration } from "@leitwerk-dev/gitlab/testing";
import jiraExtension, { setupJiraIntegration } from "@leitwerk-dev/jira";
import { LocalJiraAdapter } from "@leitwerk-dev/jira/testing";
import { createJiraGitLabLauncher } from "@leitwerk-dev/jira-gitlab-change";
import { buildProcessWatchers } from "@leitwerk-dev/process-sdk";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import { createExtensionIntegrationHarness } from "@leitwerk-dev/test-support/integration";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { expect, it, onTestFinished } from "vitest";
import splitter, { jiraEpicSplitProcess } from "./index.js";

it.each([
	"Epic",
	"Story",
])("reviews a %s batch, shares evidence, survives restart, and publishes only approved tickets", async (sourceType) => {
	const root = mkdtempSync(join(tmpdir(), "epic-flow-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const git = new LocalGit(root);
	const gitlab = new LocalGitLabAdapter(root);
	for (const name of ["one", "two"])
		gitlab.addProject(
			`team/${name}`,
			git.seed({ owner: "team", name, files: { "README.md": "Old template" } }).bare,
		);
	const jira = new LocalJiraAdapter();
	jira.seedIssue({
		id: "10",
		key: "APP-10",
		fields: {
			summary: "Standardize readmes",
			description: "Use the shared sections",
			issuetype: { id: sourceType.toLowerCase(), name: sourceType, subtask: false },
			project: { id: "100", key: "APP", name: "App" },
			components: [],
			labels: [],
			status: { statusCategory: { key: "new" } },
		},
	});
	const originalCredentials = jiraEpicSplitProcess.repositoryCredentials;
	jiraEpicSplitProcess.repositoryCredentials = () => [];
	onTestFinished(() => {
		jiraEpicSplitProcess.repositoryCredentials = originalCredentials;
	});
	const mapping = { ...createJiraGitLabLauncher().mapping, choices: undefined };
	const test = await createExtensionIntegrationHarness({
		execution: "manual",
		polling: "manual",
		extensions: [
			{
				manifest: { id: "jira", version: "1" },
				scopedSettings: jiraExtension.scopedSettings,
				setupServer(api) {
					setupJiraIntegration(api, { profiles: () => ["team"], client: () => jira });
				},
			},
			{
				manifest: { id: "gitlab", version: "1" },
				setupServer(api) {
					setupGitLabIntegration(api, { profiles: () => ["team"], client: () => gitlab.client() });
				},
			},
			{
				manifest: { id: "git-ssh", version: "1" },
				setupServer(api) {
					api.provide(gitSshIntegration, {
						profiles: () => ["team"],
						preflight: async () => ({ ok: true }),
					});
				},
			},
			{
				manifest: { id: "jira-gitlab-change", version: "1" },
				scopedSettings: { settings: [mapping] },
			},
			splitter,
			{
				manifest: { id: "split-model", version: "1" },
				modelProviders: fixtureModelProviders({
					id: "split-model",
					modelId: "scripted",
					server: true,
				}),
			},
		],
		models: [{ id: "scripted", provider: "split-model", modelId: "scripted" }],
		defaultModel: "scripted",
	});
	onTestFinished(() => test.close());
	const scopes = await test.request({ method: "POST", url: "/api/settings/scopes/refresh" });
	expect(scopes.statusCode, scopes.body).toBe(200);
	const subject = scopes
		.json<{ subjects: SettingsSubject[] }>()
		.subjects.find((subject) => subject.scopeType === "jira.component")!;
	async function mapRepositories(ids: number[], expectedRevision: number) {
		const response = await test.request({
			method: "PUT",
			url: "/api/settings/overrides",
			payload: {
				subjectId: subject.id,
				key: mapping.key,
				value: ids.map((projectId) =>
					JSON.stringify({
						origin: gitlab.baseUrl,
						projectId,
						gitlabProfile: "team",
						sshProfile: "team",
					}),
				),
				mode: "replace",
				reset: false,
				expectedRevision,
			},
		});
		expect(response.statusCode, response.body).toBe(200);
	}
	await mapRepositories([1], 0);
	const watcher = buildProcessWatchers(jiraEpicSplitProcess)!.watchers.get("epic_split")!;
	const event = {
		jiraProfile: "team",
		gitlabProfile: "team",
		sshProfile: "team",
		jiraProjects: ["100"],
		groups: "team",
		issue: await jira.getIssue("10"),
	};
	await expect(watcher.resolveLaunchConfig(event, {})).rejects.toThrow("no longer eligible");
	const watcherIds = [];
	for (const label of ["leitwerk-issue-split", "leitwerk-epic-split"]) {
		jira.issues.get("10")!.fields.labels = [label];
		const watched = await watcher.resolveLaunchConfig(event, {});
		watcherIds.push(watched.externalId);
		expect(watched.params.issueType).toBe(sourceType === "Epic" ? "Story" : "Sub-task");
	}
	expect(watcherIds[0]).toBe(watcherIds[1]);
	jira.issues.get("10")!.fields.labels = [];
	const process = await test.launch("jira_epic_split_process.ui_launcher", {
		jiraProfile: "team",
		gitlabProfile: "team",
		sshProfile: "team",
		...(sourceType === "Epic" ? { epic: "APP-10" } : { issue: "APP-10" }),
		groups: "team",
		issueType: "Story",
		labels: "",
	});
	await process.waitFor((snapshot) => snapshot.process.lifecycleStatus === "active");
	expect((await process.runTurn()).failure).toBeNull();
	const discovery = await process.runTurn({
		tools: [
			{
				name: "candidates_identified",
				arguments: {
					markdown: "Both repositories contain README files and require assessment.",
					decisions: JSON.stringify(
						[1, 2].map((id) => ({
							repositoryKey: `repo_${id}`,
							candidate: true,
							reason: "Contains a readme",
						})),
					),
				},
			},
		],
	});
	expect(discovery.failure, JSON.stringify(discovery)).toBeNull();
	for (const projectId of [1, 2]) {
		const revision = (await gitlab.client().getBranch(projectId, "main")).commit.id;
		const result = await process.runTurn({
			tools: [
				{ name: "checkout_repository", arguments: { projectKey: `repo_${projectId}` } },
				{ name: "wiki_index", arguments: {} },
				projectId === 1
					? {
							name: "wiki_share",
							arguments: {
								pageId: "readme-template",
								expectedRevision: 0,
								title: "Shared README sections",
								markdown: "Use Setup, Development, and Validation sections.",
								applicability: "Repositories with the old README format",
								status: "observed",
								evidence: [
									{
										repository: "team/one",
										path: "README.md",
										revision,
										observation: "Old sections are present",
									},
								],
								links: [],
							},
						}
					: { name: "wiki_read", arguments: { pageId: "readme-template" } },
				{
					name: "repository_assessed",
					arguments: {
						markdown: "README requires standardization; evidence and acceptance criteria recorded.",
						assessment: JSON.stringify({
							repositoryKey: `repo_${projectId}`,
							verdict: "applicable",
							reason: "Old README format",
							evidence: "README.md lacks shared sections",
							revision,
							summary: "Standardize README",
							description:
								"Use the new sections. Acceptance: README has Setup, Development, and Validation.",
							issueType: sourceType === "Epic" ? "Story" : "Sub-task",
						}),
					},
				},
			],
		});
		expect(result.failure, JSON.stringify(result)).toBeNull();
		expect(result.toolResults.some((result) => result.name === "checkout_repository")).toBe(true);
	}
	expect((await process.runTurn()).failure).toBeNull();
	expect(process.snapshot().process.selectedTurnId).toBe("batch_review");
	expect(jira.creations).toHaveLength(0);
	await test.restart();
	if (sourceType === "Story") {
		await expect(process.action("approve_batch", { tasks: "team/one" })).rejects.toThrow(
			"Subtask splits cannot create Tasks",
		);
		expect(jira.creations).toHaveLength(0);
	}
	expect((await process.action("approve_batch")).statusCode).toBe(200);
	expect((await process.runTurn()).failure).toBeNull();
	expect(jira.creations).toHaveLength(1);
	expect(jira.creations[0].labels).not.toContain("use-leitwerk");
	expect((await process.runTurn()).failure).toBeNull();
	expect(process.snapshot().process.selectedTurnId).toBe("batch_review");
	await mapRepositories([1, 2], 1);
	expect((await process.action("refresh_mappings")).statusCode).toBe(200);
	expect((await process.runTurn()).failure).toBeNull();
	expect(
		(
			await process.action("approve_batch", {
				labels: "use-leitwerk",
				tasks: sourceType === "Epic" ? "team/two" : "",
			})
		).statusCode,
	).toBe(200);
	expect((await process.runTurn()).failure).toBeNull();
	expect((await process.runTurn()).failure).toBeNull();
	expect(process.snapshot().process.lifecycleStatus).toBe("completed");
	expect(jira.creations).toHaveLength(2);
	expect(jira.creations[1].issuetype).toEqual({ id: sourceType === "Epic" ? "Task" : "10003" });
	if (sourceType === "Story") {
		for (const creation of jira.creations) {
			expect(creation.parent).toEqual({ id: "10" });
			expect(creation).not.toHaveProperty("customfield_100");
		}
	}
	expect((await jira.getIssue("1002")).fields.labels).toContain("use-leitwerk");
	const topics = (await test.request({ url: "/api/wiki/topics" })).json<{ topics: WikiTopic[] }>();
	expect(topics.topics).toHaveLength(1);
	const wikiPath = `/api/wiki/topics/${topics.topics[0].id}`;
	const page = (await test.request({ url: wikiPath })).json<{ pages: WikiPage[] }>().pages[0];
	expect(page.instanceId).toBe(process.id);
	expect(page.turnRecordId).toBeTruthy();
	expect(
		(await test.request({ method: "DELETE", url: `${wikiPath}/pages/${page.id}?revision=9` }))
			.statusCode,
	).toBe(409);
	expect(
		(
			await test.request({
				method: "DELETE",
				url: `${wikiPath}/pages/${page.id}?revision=${page.revision}`,
			})
		).statusCode,
	).toBe(200);
	expect((await test.request({ url: wikiPath })).json<{ pages: WikiPage[] }>().pages).toEqual([]);
	expect((await test.request({ url: `${wikiPath}/pages/${page.id}/history` })).statusCode).toBe(
		404,
	);
}, 120_000);

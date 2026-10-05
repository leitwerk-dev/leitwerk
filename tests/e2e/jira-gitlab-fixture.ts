import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import coding from "@leitwerk-dev/coding";
import { readPublicationState } from "@leitwerk-dev/coding/repository-change-publication";
import { SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import { LocalGitLabAdapter, setupGitLabIntegration } from "@leitwerk-dev/gitlab/testing";
import jira, {
	type JiraComment,
	type JiraIssue,
	type JiraSourceConfig,
	setupJiraIntegration,
} from "@leitwerk-dev/jira";
import { LocalJiraSplitAdapter as LocalJiraAdapter } from "@leitwerk-dev/jira/testing";
import { createJiraGitLabChange, type JiraGitLabParams } from "@leitwerk-dev/jira-gitlab-change";
import type { CoreServerSetupDeps } from "@leitwerk-dev/process-sdk";
import { createPollingTestExtension, fixtureModelProviders } from "@leitwerk-dev/test-support";
import {
	createIntegrationHarness,
	createProcessDriver,
	type IntegrationHarness,
	waitForValue,
} from "@leitwerk-dev/test-support/integration";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import {
	createInProcessWorkerSpawn,
	StubPiTreeHandleFactory,
} from "@leitwerk-dev/test-support/worker-testing";
import { expect } from "vitest";

export async function jiraFixture(
	onFinished: (fn: () => Promise<void>) => void,
	options: {
		skipPlan?: boolean;
		skipSimplification?: boolean;
		noChanges?: boolean;
		emptyFindings?: boolean;
		labelDuringSimplification?: boolean;
		cancelAfterFirstPublication?: boolean;
	} = {},
) {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-jira-change-"));
	const git = new LocalGit(root);
	const remotes = ["service", "client"].map(
		(name) => git.seed({ owner: "team", name, files: { "README.md": `${name}\n` } }).bare,
	);
	const gitlab = new LocalGitLabAdapter(root);
	remotes.forEach((bare, i) => {
		gitlab.addProject(`team/${i === 0 ? "service" : "client"}`, bare);
	});
	let clock = Date.now(),
		issueUnavailable = false,
		loseComment = false,
		edits = 0;
	let failPublication = false;
	let repairMode: "change" | "none" | "operator" = "change";
	const issue: JiraIssue = {
		id: "501",
		key: "APP-1",
		fields: {
			summary: "Coordinate service and client",
			description: "Update both readmes",
			project: { id: "100", key: "APP", name: "App" },
			components: [
				{ id: "200", name: "Service" },
				{ id: "201", name: "Client" },
				{ id: "202", name: "Unmapped" },
			],
			labels: [
				"use-leitwerk",
				...(options.skipPlan ? ["leitwerk-skip-plan-decision"] : []),
				...(options.skipSimplification ? ["leitwerk-skip-simplification"] : []),
			],
			status: { statusCategory: { key: "new" } },
		},
	};
	const comments: JiraComment[] = [];
	const jiraClient = new LocalJiraAdapter();
	jiraClient.issues.set(issue.id, issue);
	jiraClient.comments.set(issue.id, comments);
	jiraClient.components = issue.fields.components;
	const getIssue = jiraClient.getIssue.bind(jiraClient);
	jiraClient.getIssue = async (id) => {
		if (issueUnavailable) throw new Error("Jira unavailable");
		return getIssue(id);
	};
	const addComment = jiraClient.addComment.bind(jiraClient);
	jiraClient.addComment = async (id, body) => {
		const comment = await addComment(id, body);
		if (loseComment) {
			loseComment = false;
			throw new Error("Response lost after Jira write");
		}
		return comment;
	};
	const prompts: { tools: string[]; prompt: string }[] = [];
	const pi = new StubPiTreeHandleFactory({
		toolCallScriptResolver({ tools, promptText, workspaceRoot }) {
			if (!workspaceRoot) throw new Error("Missing workspace root");
			const treeText =
				pi.sessions
					.at(-1)
					?.getBranch()
					.map((entry) =>
						entry.type === "custom_message"
							? entry.content
							: entry.type === "message"
								? entry.message?.content
								: "",
					)
					.filter((value): value is string => typeof value === "string")
					.join("\n\n") ?? "";
			promptText = `${treeText}\n${promptText}`;
			const names = tools.map((tool) => tool.name);
			prompts.push({ tools: names, prompt: promptText });
			if (names.includes("plan_saved"))
				return {
					calls: [
						{
							toolName: "plan_saved",
							args: {
								markdown: "# Coordinated plan\nUpdate both repositories",
								summary: "Update both",
								acceptanceCriteria: ["Both readmes changed"],
							},
						},
					],
				};
			if (names.includes("implementation_ready")) {
				if (!options.noChanges)
					for (const key of ["repo_1", "repo_2"])
						writeFileSync(
							path.join(workspaceRoot, key, "README.md"),
							`${key} revision ${++edits}\n`,
						);
				return {
					calls: [
						{
							toolName: "implementation_ready",
							args: { markdown: "Implemented and checked both repositories" },
						},
					],
				};
			}
			if (names.includes("changes_ready")) {
				const key = promptText.match(/Repository: (repo_\d+)/)?.[1];
				if (key && repairMode === "change")
					writeFileSync(path.join(workspaceRoot, key, "README.md"), `Repaired ${key} ${++edits}\n`);
				return {
					calls: [
						{
							toolName:
								repairMode === "operator"
									? "cannot_repair"
									: repairMode === "none"
										? "no_changes"
										: "changes_ready",
							args: { markdown: "Repair checked" },
						},
					],
				};
			}
			if (
				options.labelDuringSimplification &&
				promptText.includes("Review all uncommitted changes")
			)
				issue.fields.labels.push("leitwerk-skip-simplification");
			const markdown = promptText.includes("Return only a JSON object")
				? JSON.stringify({ repo_1: "feat: update service", repo_2: "feat: update client" })
				: promptText.includes("Review all uncommitted changes")
					? options.emptyFindings
						? "No worthwhile simplifications."
						: "repo_1: remove duplication. repo_2: retain the current structure."
					: "Applied justified findings and reran checks";
			return { calls: [{ toolName: "markdown_result", args: { markdown } }] };
		},
	});
	let harness: IntegrationHarness;
	let polls: (() => Promise<{ errors: string[] }>)[] = [];
	let flow: ReturnType<typeof createJiraGitLabChange>;
	async function start(listen = true) {
		polls = [];
		flow = createJiraGitLabChange({ docker: false });
		// Owned local fixture uses file transport; production sends only git-ssh references.
		flow.process.repositoryCredentials = () => [];
		const providers = [
			{
				...createPollingTestExtension(
					jira.manifest,
					(api) =>
						setupJiraIntegration(
							api,
							{ profiles: () => ["team"], client: () => jiraClient },
							{ now: () => clock },
						),
					true,
				),
				scopedSettings: jira.scopedSettings,
			},
			createPollingTestExtension(
				{ id: "gitlab", version: "1.0.0" },
				(api) =>
					setupGitLabIntegration(
						api,
						{
							profiles: () => ["team"],
							client: () => {
								const client = gitlab.client();
								return {
									...client,
									async createMergeRequest(...args: Parameters<typeof client.createMergeRequest>) {
										if (failPublication && args[0] === 2)
											throw new Error("Second repository publication unavailable");
										const mr = await client.createMergeRequest(...args);
										if (options.cancelAfterFirstPublication) issue.fields.labels = [];
										return mr;
									},
								};
							},
						},
						{ now: () => clock },
					),
				true,
			),
		];
		polls = providers.map((provider) => () => provider.poll());
		const catalog = await buildExtensionCatalogFromModules([
			coding,
			...providers,
			{
				manifest: { id: "git-ssh", version: "1.0.0" },
				setupServer(api) {
					api.provide(gitSshIntegration, {
						profiles: () => ["team"],
						async preflight(input) {
							if (!remotes.includes(input.repoLocator)) throw new Error("Unexpected repository");
							return { ok: true };
						},
					});
				},
			},
			flow.extension,
			{
				manifest: { id: "jira-test-model", version: "1.0.0" },
				modelProviders: fixtureModelProviders({
					id: "jira-test-model",
					modelId: "fake",
					server: true,
				}),
			},
		]);
		harness = await createIntegrationHarness({
			listen,
			extensionCatalog: catalog,
			appOverrides: {
				localWorkerSpawnImpl: createInProcessWorkerSpawn({
					extensionCatalog: catalog,
					piFactory: pi,
				}),
			},
			configOverride(config) {
				config.storage.sqlite_path = path.join(root, "state.sqlite");
				config.storage.tree_files_dir = path.join(root, "trees");
				config.storage.process_workspaces_dir = path.join(root, "workspaces");
				config.pi.agent_dir = path.join(root, "pi");
				config.pi.model_profiles = [
					{ id: "fake", provider: "jira-test-model", model_id: "fake", thinking_level: "off" },
				];
				config.pi.process_title_generation.model_profile = "fake";
				config.process_configs = {
					jira_gitlab_change_process: {
						default_model_profile: "fake",
						turn_configs: {},
						watchers: { use_leitwerk: { enabled: true, profile: "team", projects: ["100"] } },
					},
				};
			},
		});
	}
	onFinished(async () => {
		await harness?.ctx.app.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	await start(false);
	const settings = harness.ctx.deps.scopedSettingsService;
	if (!settings) throw new Error("Missing scoped settings");
	await settings.refresh();
	const subjects = settings.listScopes().subjects;
	for (const [component, projectIds] of [
		["200", [1]],
		["201", [1, 2]],
	] as const) {
		const subject = subjects.find(
			(subject) =>
				subject.scopeType === "jira.component" && JSON.parse(subject.identity)[1] === component,
		);
		if (!subject) throw new Error("Missing component subject");
		settings.write({
			subjectId: subject.id,
			key: flow?.launcher.mapping.key,
			value: projectIds.map((projectId) =>
				JSON.stringify({
					origin: gitlab.baseUrl,
					projectId,
					gitlabProfile: "team",
					sshProfile: "team",
				}),
			),
			mode: "replace",
			reset: false,
			expectedRevision: 0,
			actor: SYSTEM_ACTOR,
		});
	}
	await harness.ctx.listen({ host: "127.0.0.1", port: 0, useBoundAddressAsBaseUrl: true });
	const driver = createProcessDriver(() => harness.ctx);
	const wait: typeof driver.wait = (id, turn, lifecycle = "waiting", timeout = 12000) =>
		driver.waitForProcess(
			id,
			(process) => {
				if (process.selectedTurnId !== turn || process.lifecycleStatus !== lifecycle) return false;
				if (turn !== "deliver_change" || lifecycle !== "waiting") return true;
				const params = JSON.parse(process.paramsJson ?? "{}") as JiraGitLabParams;
				const state = JSON.parse(process.stateJson ?? "{}");
				return params.repositories.every(({ key }) => {
					const current = readPublicationState(state, `jiraGitLabChange:${key}`);
					return (
						current.noChanges ||
						current.delivery.terminalPullRequest ||
						(current.delivery.stage === "awaiting" &&
							!current.delivery.adjustment &&
							!current.pendingEvidence &&
							current.feedbackIds.length === 0)
					);
				});
			},
			`${turn}/${lifecycle} with delivery settled`,
			timeout,
			lifecycle === "error",
		);
	const poll = async () => {
		clock += 180000;
		for (const run of polls) {
			const result = await run();
			expect(result.errors).toEqual([]);
		}
		for (const { id } of harness.ctx.deps.processes.listAll())
			await driver.waitForProcess(
				id,
				(process) =>
					process.lifecycleStatus !== "active" && process.lifecycleStatus !== "discovered",
				"settled provider observation",
			);
	};
	const state = (id: string) =>
		JSON.parse(harness.ctx.deps.processes.getById(id)?.stateJson ?? "{}");
	return {
		...driver,
		wait,
		issue,
		comments,
		gitlab,
		prompts,
		remotes,
		git,
		state,
		poll,
		waitForPlanBypass: (id: string, planRevision: number) =>
			waitForValue(
				() =>
					(harness.ctx.deps.externalSourceService as CoreServerSetupDeps["externalSources"])
						.listArmed("@leitwerk-dev/jira.issue-policy")
						.some(
							(s) =>
								s.instanceId === id &&
								(s.resolved as JiraSourceConfig).planRevision === planRevision,
						),
				Boolean,
				12000,
			),
		get harness() {
			return harness;
		},
		get flow() {
			return flow;
		},
		remote(id: string, key: string) {
			return readPublicationState(state(id), `jiraGitLabChange:${key}`);
		},
		setPublicationFailure(value: boolean) {
			failPublication = value;
		},
		setUnavailable(value: boolean) {
			issueUnavailable = value;
		},
		async pollDiscovery() {
			clock += 30000;
			return polls[0]();
		},
		loseComment() {
			loseComment = true;
		},
		setRepair(value: typeof repairMode) {
			repairMode = value;
		},
		async discover() {
			await poll();
			const process = await waitForValue(
				() =>
					harness.ctx.deps.processes
						.listAll()
						.find((process) => process.processId === "jira_gitlab_change_process"),
				Boolean,
				12000,
			);
			if (!process) throw new Error("No Jira process");
			return process.id;
		},
		async launch() {
			const id = await this.discover();
			if (!options.skipPlan) {
				await driver.wait(id, "plan_decision");
				await driver.action(id, "approve_plan");
			}
			await wait(
				id,
				options.noChanges ? null : "deliver_change",
				options.noChanges ? "completed" : "waiting",
			);
			return id;
		},
		async restart() {
			await harness.ctx.app.close();
			await start();
		},
		params(id: string) {
			return JSON.parse(
				harness.ctx.deps.processes.getById(id)?.paramsJson ?? "{}",
			) as JiraGitLabParams;
		},
	};
}

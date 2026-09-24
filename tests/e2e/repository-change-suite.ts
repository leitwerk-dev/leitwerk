import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import codingExtension from "@leitwerk-dev/coding";
import {
	patchPublicationState,
	readPublicationState,
} from "@leitwerk-dev/coding/repository-change-publication";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import { GITHUB_PR_TERMINAL_KIND, setupGitHubIntegration } from "@leitwerk-dev/github";
import { LocalGitHubAdapter } from "@leitwerk-dev/github/testing";
import { createGitHubRepoChange } from "@leitwerk-dev/github-repo-change";
import {
	GITLAB_MR_KIND,
	LocalGitLabAdapter,
	setupGitLabIntegration,
} from "@leitwerk-dev/gitlab/testing";
import { createGitLabRepoChange } from "@leitwerk-dev/gitlab-repo-change";
import {
	type CapabilityToken,
	type CoreServerSetupDeps,
	coreHostCapabilities,
	createEmptyStructuralProcessState,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import {
	createPollingTestExtension,
	FakeLlmProvider,
	fixtureModelProviders,
	postImmediateLaunch,
} from "@leitwerk-dev/test-support";
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
import { describe, expect, it } from "vitest";

type Provider = "github" | "gitlab";
async function fixture(provider: Provider, onFinished: (fn: () => Promise<void>) => void) {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-change-flow-"));
	let harness: IntegrationHarness;
	let github: LocalGitHubAdapter;
	let gitlab: LocalGitLabAdapter;
	let pollProvider: () => Promise<unknown>;
	let clock = Date.now();
	let repairMode: "change" | "none" | "operator" = "change";
	let edit = 0;
	const git = new LocalGit(root);
	const bare = git.seed({ owner: "team", name: "repo", files: { "README.md": "Initial\n" } }).bare;
	const model = new FakeLlmProvider();
	model.onPrompt((serialized) => {
		const { tools, prompt } = JSON.parse(serialized) as { tools: string[]; prompt: string };
		if (tools.includes("plan_saved"))
			return {
				content: "",
				toolCalls: [
					{
						name: "plan_saved",
						arguments: {
							markdown: "# Plan\nUpdate README.md",
							summary: "Update readme",
							acceptanceCriteria: ["Readme updated"],
						},
					},
				],
			};
		if (tools.includes("changes_ready"))
			return {
				content: "",
				toolCalls: [
					{
						name:
							repairMode === "operator"
								? "cannot_repair"
								: repairMode === "none"
									? "no_changes"
									: "changes_ready",
						arguments: { markdown: "Verified repository adjustment" },
					},
				],
			};
		return {
			content: "",
			toolCalls: [
				{
					name: "markdown_result",
					arguments: {
						markdown: prompt.includes("Follow this plan:")
							? "Updated the readme"
							: "docs: update readme",
					},
				},
			],
		};
	});
	const pi = new StubPiTreeHandleFactory({
		toolCallScriptResolver({ tools, promptText, sessionCwd, workspaceRoot, instanceId }) {
			const names = tools.map((t) => t.name);
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
			const prompt = `${treeText}\n${promptText}`;
			const response = model.respond(JSON.stringify({ tools: names, prompt }));
			const cwd = sessionCwd ?? workspaceRoot;
			if (!cwd) throw new Error("Missing checkout");
			if (
				(prompt.includes("Implement this requested change:") &&
					prompt.includes("Follow this plan:")) ||
				(names.includes("changes_ready") && repairMode === "change")
			)
				writeFileSync(path.join(cwd, "README.md"), `Repository revision ${++edit}\n`);
			const calls = (response.toolCalls ?? []).map((c) => ({
				toolName: c.name,
				args: c.arguments,
			}));
			if (names.includes("github_get_ci_diagnostics") && instanceId) {
				const s = state(instanceId);
				calls.unshift({
					toolName: "github_get_ci_diagnostics",
					args: { projectKey: "repo", pullRequestNumber: s.prNumber, headSha: s.headSha },
				});
			}
			if (names.includes("gitlab_list_failed_jobs") && instanceId) {
				const s = state(instanceId);
				calls.unshift({
					toolName: "gitlab_list_failed_jobs",
					args: { projectKey: "repo", pipelineId: s.pipeline?.number },
				});
			}
			return { calls };
		},
	});
	const processId = `${provider}_repo_change_process`;
	const state = (id: string) =>
		readPublicationState(
			JSON.parse(harness.ctx.deps.processes.getById(id)?.stateJson ?? "{}"),
			`${provider}RepoChange`,
		);
	await mkdir(path.join(root, "trees"), { recursive: true });
	await mkdir(path.join(root, "workspaces"), { recursive: true });
	async function start(listen = true) {
		github = new LocalGitHubAdapter({ root, baseUrl: "https://github.test", now: () => clock });
		github.seed({ owner: "team", name: "repo", files: { "README.md": "Initial\n" } });
		gitlab = new LocalGitLabAdapter(root);
		if (!gitlab.state.projects.length) gitlab.addProject("team/subgroup/repo", bare);
		const flow =
			provider === "github"
				? createGitHubRepoChange({ docker: false })
				: createGitLabRepoChange({ docker: false });
		// Only this owned local composition replaces production credential delivery.
		flow.process.repositoryCredentials = () => [];
		const polling = createPollingTestExtension({ id: provider, version: "1.0.0" }, (api) => {
			const deps = api.get(coreHostCapabilities.serverSetup);
			if (!deps || Array.isArray(deps)) throw new Error("Missing server setup capability");
			// Drive the real provider's poll explicitly. A scheduled poll can otherwise
			// coalesce with our call before newly added evidence is visible, leaving
			// the test waiting for the next five-second timer tick.
			const manualDeps: CoreServerSetupDeps = {
				...deps,
				polling: { create: ({ pollOnce }) => ({ poll: pollOnce }) },
			};
			const manualApi = {
				...api,
				get<T>(token: CapabilityToken<T>): T | T[] | undefined {
					return token === coreHostCapabilities.serverSetup ? (manualDeps as T) : api.get(token);
				},
			};
			return provider === "github"
				? setupGitHubIntegration(
						manualApi,
						{ profiles: () => ["team"], client: () => github.client() },
						{ now: () => clock },
					)
				: setupGitLabIntegration(
						manualApi,
						{ profiles: () => ["team"], client: () => gitlab.client() },
						{ now: () => clock },
					);
		});
		pollProvider = () => polling.poll();
		const ssh: LeitwerkExtensionModule = {
			manifest: { id: "git-ssh", version: "1.0.0" },
			setupServer(api) {
				api.provide(gitSshIntegration, {
					profiles: () => ["team"],
					async preflight(input) {
						if (input.repoLocator !== bare)
							return {
								ok: false as const,
								access: "read" as const,
								detail: "Unknown local repository",
							};
						git.run(bare, [
							"push",
							"--dry-run",
							bare,
							`${input.baseBranch}:refs/heads/leitwerk/preflight`,
						]);
						return { ok: true as const };
					},
				});
			},
		};
		const catalog = await buildExtensionCatalogFromModules([
			codingExtension,
			polling,
			ssh,
			flow.extension,
			{
				manifest: { id: "change-test-model", version: "1.0.0" },
				modelProviders: fixtureModelProviders({
					id: "change-test-model",
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
				config.pi.agent_dir = path.join(root, "pi-agent");
				config.pi.model_profiles = [
					{ id: "fake", provider: "change-test-model", model_id: "fake", thinking_level: "off" },
				];
				config.pi.process_title_generation.model_profile = "fake";
				config.process_configs = {
					[processId]: {
						default_model_profile: "fake",
						turn_configs: {},
						watchers: {
							use_leitwerk: {
								enabled: true,
								profile: "team",
								poll_interval: "30s",
								labels: { trigger: "use-leitwerk", done: "leitwerk-done" },
								...(provider === "gitlab" ? { projects: { include: ["team/subgroup/repo"] } } : {}),
							},
						},
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
	const driver = createProcessDriver(() => harness.ctx);
	const armed = async (id: string) => {
		await driver.wait(id, "deliver_change");
		await waitForValue(
			() =>
				(harness.ctx.deps.externalSourceService as CoreServerSetupDeps["externalSources"])
					.listArmed(provider === "github" ? GITHUB_PR_TERMINAL_KIND : GITLAB_MR_KIND)
					.some((s) => s.instanceId === id),
			Boolean,
			12000,
		);
	};
	const poll = async () => {
		clock += 180000;
		const result = (await pollProvider()) as { errors: string[] };
		expect(result.errors).toEqual([]);
		// A provider observation can start an automatic worker turn. Let it finish
		// and rearm before the next remote edit/poll, as the real timer normally does.
		await Promise.all(
			harness.ctx.deps.processes.listAll().map(async ({ id }) => {
				const process = await driver.waitForProcess(
					id,
					(p) => p.lifecycleStatus !== "active" && p.lifecycleStatus !== "discovered",
					"settled provider observation",
				);
				if (process.selectedTurnId === "deliver_change" && process.lifecycleStatus === "waiting")
					await armed(id);
			}),
		);
	};
	return {
		...driver,
		state,
		armed,
		poll,
		get harness() {
			return harness;
		},
		get github() {
			return github;
		},
		get gitlab() {
			return gitlab;
		},
		get repo() {
			return github.repo("team", "repo");
		},
		get bare() {
			return bare;
		},
		git,
		setRepair(mode: typeof repairMode) {
			repairMode = mode;
		},
		async launch(issueOrigin = false) {
			await harness.ctx.listen({
				host: "127.0.0.1",
				port: 0,
				useBoundAddressAsBaseUrl: true,
			});
			let id: string;
			if (issueOrigin) {
				if (provider === "github") {
					const r = github.repo("team", "repo");
					const issue = github.createIssue(r, { title: "Update readme" });
					github.setIssueLabel(r, issue.number, "use-leitwerk", "developer");
				} else gitlab.createIssue(1, "Update readme");
				await poll();
				const process = await waitForValue(
					() => harness.ctx.deps.processes.listAll().find((p) => p.processId === processId),
					Boolean,
					12000,
				);
				if (!process) throw new Error("No issue process");
				id = process.id;
			} else {
				const response = await postImmediateLaunch(harness.address, `${processId}.ui_launcher`, {
					launcherInput: {
						[`${provider}Profile`]: "team",
						repository: provider === "github" ? "team/repo" : "1",
						prompt: "Update readme",
					},
				});
				const body = (await response.json()) as { process: { id: string } };
				expect(response.status, JSON.stringify(body)).toBe(201);
				id = body.process.id;
			}
			await driver.wait(id, "plan_decision");
			await driver.action(id, "approve_plan");
			await driver.wait(id, "implementation_decision");
			await driver.action(id, "finalize_change");
			await armed(id);
			return id;
		},
		async seedDelivery(issueOrigin = false, ciRecoveryCycles = 0) {
			// Only delivery preconditions are seeded. Discovery/publication have full
			// workflow cases; evidence, repair and operator actions use real handlers.
			const workBranch = "leitwerk/seeded-delivery";
			git.run(bare, ["branch", workBranch, "main"]);
			const headSha = git.run(bare, ["rev-parse", workBranch]).trim();
			let issueNumber: number | null = null;
			let issueUrl: string | null = null;
			if (issueOrigin) {
				if (provider === "github") {
					const repo = github.repo("team", "repo");
					const issue = github.createIssue(repo, { title: "Update readme" });
					github.setIssueLabel(repo, issue.number, "use-leitwerk", "developer");
					issueNumber = issue.number;
					issueUrl = issue.html_url;
				} else {
					const issue = gitlab.createIssue(1, "Update readme");
					issueNumber = issue.iid;
					issueUrl = issue.web_url;
				}
			}
			const request =
				provider === "github"
					? await github.client().createPullRequest("team", "repo", {
							title: "Update readme",
							body: "Published change",
							head: workBranch,
							base: "main",
						})
					: gitlab.openMr(gitlab.state.projects[0], workBranch);
			const prNumber = "number" in request ? request.number : request.iid;
			const prUrl = "html_url" in request ? request.html_url : request.web_url;
			const params = {
				repoLocator: bare,
				baseBranch: "main",
				workBranch,
				prompt: "Update readme",
				owner: provider === "github" ? "team" : "team/subgroup",
				repo: "repo",
				origin: issueOrigin ? "issue" : "ui",
				issueNumber,
				issueUrl,
				triggerLabel: issueOrigin ? "use-leitwerk" : null,
				doneLabel: issueOrigin ? "leitwerk-done" : null,
				...(provider === "github"
					? { githubProfile: "team", sshCredentialRef: "team" }
					: { gitlabProfile: "team", gitlabOrigin: "https://gitlab.test", projectId: 1 }),
			};
			const process = harness.ctx.deps.processes.create({
				processId,
				title: "Update readme",
				selectedTurnId: "deliver_change",
				lifecycleStatus: "waiting",
				externalId: issueOrigin
					? provider === "github"
						? `github:team/repo#${issueNumber}`
						: `gitlab:https://gitlab.test:1#${issueNumber}`
					: null,
				externalUrl: issueUrl,
				paramsJson: JSON.stringify(params),
				stateJson: JSON.stringify(
					patchPublicationState(
						{
							...createEmptyStructuralProcessState(),
							finalization: { generatedCommitMessage: "docs: update readme" },
						},
						`${provider}RepoChange`,
						{
							headSha,
							prNumber,
							prUrl,
							ciRecoveryCycles,
							delivery: { stage: "awaiting", issueLinked: issueOrigin },
						},
					),
				),
			});
			const identity =
				provider === "github"
					? await github.client().resolveGitIdentity("team")
					: await gitlab.client().resolveGitIdentity();
			harness.ctx.deps.projects.create({
				instanceId: process.id,
				key: "repo",
				repoLocator: bare,
				baseBranch: "main",
				workBranch,
				metadata: {
					"leitwerk.gitIdentity": {
						provider,
						profile: "team",
						name: identity.name,
						email: identity.email,
						login: "login" in identity ? identity.login : identity.username,
					},
					...(provider === "github"
						? {
								github: {
									profile: "team",
									owner: "team",
									repo: "repo",
									...(issueOrigin ? { issueNumber } : {}),
								},
							}
						: {
								gitlab: {
									profile: "team",
									projectId: 1,
									iid: prNumber,
									...(issueOrigin ? { issueIid: issueNumber } : {}),
								},
							}),
				},
			});
			// Startup must recover the persisted waiting delivery and arm its sources.
			await harness.ctx.listen({
				host: "127.0.0.1",
				port: 0,
				useBoundAddressAsBaseUrl: true,
			});
			await armed(process.id);
			// Consume the initial healthy observation before testing new evidence.
			await poll();
			await armed(process.id);
			return process.id;
		},
		async restart() {
			await harness.ctx.app.close();
			await start();
		},
		failCi(id: string) {
			const s = state(id);
			if (provider === "github")
				github.setChecks(github.repo("team", "repo"), {
					headSha: s.headSha ?? "",
					status: "failure",
					total: 1,
					failed: [
						{ name: "tests", conclusion: "failure", url: `https://github.test/check/${s.headSha}` },
					],
				});
			else gitlab.pipeline(gitlab.state.mrs[0], "failed");
		},
		feedback(id: string) {
			if (provider === "github")
				github.addFeedback(github.repo("team", "repo"), state(id).prNumber ?? 0, {
					kind: "conversation",
					body: "Improve documentation",
					author: "developer",
				});
			else {
				gitlab.state.feedback ??= {};
				gitlab.state.feedback[`1:${state(id).prNumber}`] = [
					{
						id: 101,
						discussionId: "discussion-101",
						body: "Improve documentation",
						author: "developer",
						createdAt: new Date(clock).toISOString(),
					},
				];
				gitlab.save();
			}
		},
		merge(id: string) {
			if (provider === "github") github.merge(github.repo("team", "repo"), state(id).prNumber ?? 0);
			else gitlab.merge(gitlab.state.mrs[0]);
		},
		closeRequest(id: string) {
			if (provider === "github") {
				const pr = github.repo("team", "repo").pulls.find((p) => p.number === state(id).prNumber);
				if (!pr) throw new Error("No PR");
				pr.state = "closed";
				github.save();
			} else {
				gitlab.state.mrs[0].state = "closed";
				gitlab.save();
			}
		},
	};
}
/** @internal */
export function repositoryChangeTests(provider: Provider) {
	describe(`${provider} repository change`, () => {
		it("publishes from the UI, repairs exact-head CI, and completes after a file-backed restart", async ({
			onTestFinished,
		}) => {
			const f = await fixture(provider, onTestFinished);
			const id = await f.launch();
			const head = f.state(id).headSha;
			expect(
				f.git.run(f.bare, [
					"show",
					`${JSON.parse(f.harness.ctx.deps.processes.getById(id)?.paramsJson ?? "{}").workBranch}:README.md`,
				]),
			).toContain("Repository revision");
			f.failCi(id);
			await f.poll();
			await f.waitForProcess(
				id,
				(p) =>
					readPublicationState(JSON.parse(p.stateJson ?? "{}"), `${provider}RepoChange`).headSha !==
					head,
				"repaired head",
			);
			await f.armed(id);
			expect(f.state(id).ciRecoveryCycles).toBe(1);
			const before = f.harness.ctx.deps.turnRecords.listByInstance(id).map((t) => t.id);
			await f.restart();
			await f.armed(id);
			expect(f.harness.ctx.deps.turnRecords.listByInstance(id).map((t) => t.id)).toEqual(before);
			f.merge(id);
			await f.poll();
			await f.wait(id, null, "completed");
			expect(f.harness.ctx.deps.projects.listByInstance(id)).toHaveLength(1);
		}, 45000);
		it("launches one labeled issue and reconciles it after merge without duplicate writes", async ({
			onTestFinished,
		}) => {
			const f = await fixture(provider, onTestFinished);
			if (provider === "github") f.github.state.failAfterPullRequestWrite = true;
			else f.gitlab.loseNextMergeRequestResponse = true;
			const id = await f.launch(true);
			await f.poll();
			expect(
				f.harness.ctx.deps.processes
					.listAll()
					.filter((p) => p.processId === `${provider}_repo_change_process`),
			).toHaveLength(1);
			f.merge(id);
			await f.poll();
			await f.wait(id, null, "completed");
			if (provider === "github") {
				expect(f.repo.pulls).toHaveLength(1);
				expect(f.repo.issues[0].state).toBe("closed");
				expect(f.repo.issues[0].labels.map((l) => l.name)).toContain("leitwerk-done");
			} else {
				expect(f.gitlab.state.mrs).toHaveLength(1);
				expect(f.gitlab.state.issues?.[0]).toMatchObject({
					state: "closed",
					labels: ["leitwerk-done"],
				});
			}
			const writes = f.harness.ctx.deps.externalWrites.listByInstance(id);
			await f.restart();
			expect(f.harness.ctx.deps.externalWrites.listByInstance(id)).toEqual(writes);
		}, 45000);
		it("settles feedback, preserves operator evidence over restart, and resumes waiting", async ({
			onTestFinished,
		}) => {
			const f = await fixture(provider, onTestFinished);
			const id = await f.seedDelivery();
			f.setRepair("operator");
			f.feedback(id);
			await f.poll();
			await f.wait(id, "ci_operator_action");
			expect(f.state(id).feedbackIds).toHaveLength(1);
			await f.restart();
			await f.wait(id, "ci_operator_action");
			f.setRepair("none");
			await f.action(id, "retry_repair");
			await f.armed(id);
			expect(f.state(id).feedbackIds).toEqual([]);
			f.closeRequest(id);
			await f.poll();
			await f.wait(id, null, "aborted");
		}, 45000);
	});

	it(`${provider}: allows the third automatic CI repair, refuses a fourth, and does not replay dismissed evidence`, async ({
		onTestFinished,
	}) => {
		const f = await fixture(provider, onTestFinished);
		const id = await f.seedDelivery(false, 2);
		const head = f.state(id).headSha;
		f.failCi(id);
		await f.poll();
		await f.waitForProcess(
			id,
			(p) =>
				readPublicationState(JSON.parse(p.stateJson ?? "{}"), `${provider}RepoChange`).headSha !==
				head,
			"new CI repair head",
		);
		await f.armed(id);
		expect(f.state(id).ciRecoveryCycles).toBe(3);
		const repairedHead = f.state(id).headSha;
		f.failCi(id);
		await f.poll();
		await f.wait(id, "ci_operator_action");
		expect(f.state(id).headSha).toBe(repairedHead);
		expect(f.state(id).ciRecoveryCycles).toBe(3);
		await f.action(id, "resume_waiting");
		await f.armed(id);
		await f.poll();
		expect(f.harness.ctx.deps.processes.getById(id)).toMatchObject({
			selectedTurnId: "deliver_change",
			lifecycleStatus: "waiting",
		});
	}, 90000);
	it(`${provider}: aborts waiting delivery when its source trigger is removed`, async ({
		onTestFinished,
	}) => {
		const f = await fixture(provider, onTestFinished);
		const id = await f.seedDelivery(true);
		if (provider === "github")
			f.github.setIssueLabel(f.repo, f.repo.issues[0].number, "use-leitwerk", "developer", false);
		else {
			const issue = f.gitlab.state.issues?.[0];
			if (!issue) throw new Error("No source issue");
			issue.labels = [];
			f.gitlab.save();
		}
		await f.poll();
		await f.wait(id, null, "aborted");
		if (provider === "github") expect(f.repo.issues[0].state).toBe("open");
		else expect(f.gitlab.state.issues?.[0].state).toBe("opened");
	}, 45000);
}

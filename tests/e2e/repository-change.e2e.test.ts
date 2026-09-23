import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import codingExtension from "@leitwerk-dev/coding";
import { readPublicationState } from "@leitwerk-dev/coding/repository-change-publication";
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
	type CoreServerSetupDeps,
	coreHostCapabilities,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import {
	createPollingTestExtension,
	FakeLlmProvider,
	fixtureModelProviders,
} from "@leitwerk-dev/test-support";
import {
	createExtensionIntegrationHarness,
	type ExtensionIntegrationHarness,
	type ExtensionIntegrationHarnessOptions,
	waitForValue,
} from "@leitwerk-dev/test-support/integration";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { describe, expect, it } from "vitest";

type Provider = "github" | "gitlab";
async function fixture(provider: Provider, onFinished: (fn: () => Promise<void>) => void) {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-change-flow-"));
	let harness: ExtensionIntegrationHarness;
	let github: LocalGitHubAdapter;
	let gitlab: LocalGitLabAdapter;
	let externalSources: CoreServerSetupDeps["externalSources"];
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
	const script: NonNullable<ExtensionIntegrationHarnessOptions["script"]> = (
		instanceId,
		promptText,
		{ tools, history, cwd },
	) => {
		const names = tools.map((t) => t.name);
		const prompt = `${history}\n${promptText}`;
		const response = model.respond(JSON.stringify({ tools: names, prompt }));
		if (!cwd) throw new Error("Missing checkout");
		if (
			(prompt.includes("Implement this requested change:") &&
				prompt.includes("Follow this plan:")) ||
			(names.includes("changes_ready") && repairMode === "change")
		)
			writeFileSync(path.join(cwd, "README.md"), `Repository revision ${++edit}\n`);
		const calls = response.toolCalls ?? [];
		if (names.includes("github_get_ci_diagnostics")) {
			const s = state(instanceId);
			calls.unshift({
				name: "github_get_ci_diagnostics",
				arguments: { projectKey: "repo", pullRequestNumber: s.prNumber, headSha: s.headSha },
			});
		}
		if (names.includes("gitlab_list_failed_jobs")) {
			const s = state(instanceId);
			calls.unshift({
				name: "gitlab_list_failed_jobs",
				arguments: { projectKey: "repo", pipelineId: s.pipeline?.number },
			});
		}
		return { tools: calls };
	};
	const processId = `${provider}_repo_change_process`;
	const snapshot = (id: string) => harness.process(id).snapshot();
	const state = (id: string) =>
		readPublicationState(
			JSON.parse(snapshot(id).process.stateJson ?? "{}"),
			`${provider}RepoChange`,
		);
	onFinished(async () => {
		await harness?.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	const flow =
		provider === "github"
			? createGitHubRepoChange({ docker: false })
			: createGitLabRepoChange({ docker: false });
	// Only this owned local composition replaces production credential delivery.
	flow.process.repositoryCredentials = () => [];
	const polling = createPollingTestExtension({ id: provider, version: "1.0.0" }, (api) => {
		externalSources = api.require(coreHostCapabilities.serverSetup).externalSources;
		github = new LocalGitHubAdapter({ root, baseUrl: "https://github.test", now: () => clock });
		github.seed({ owner: "team", name: "repo", files: { "README.md": "Initial\n" } });
		gitlab = new LocalGitLabAdapter(root);
		if (!gitlab.state.projects.length) gitlab.addProject("team/subgroup/repo", bare);
		return provider === "github"
			? setupGitHubIntegration(
					api,
					{ profiles: () => ["team"], client: () => github.client() },
					{ now: () => clock },
				)
			: setupGitLabIntegration(
					api,
					{ profiles: () => ["team"], client: () => gitlab.client() },
					{ now: () => clock },
				);
	});
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
	harness = await createExtensionIntegrationHarness({
		script,
		extensions: [
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
		],
		models: [{ id: "fake", provider: "change-test-model", modelId: "fake" }],
		defaultModel: "fake",
		watchers: {
			[processId]: {
				use_leitwerk: {
					enabled: true,
					profile: "team",
					poll_interval: "30s",
					labels: { trigger: "use-leitwerk", done: "leitwerk-done" },
					...(provider === "gitlab" ? { projects: { include: ["team/subgroup/repo"] } } : {}),
				},
			},
		},
	});
	const waitForProcess = (
		id: string,
		predicate: (p: ReturnType<typeof snapshot>["process"]) => boolean,
		description: string,
	) =>
		harness.process(id).waitFor(
			({ process }) => {
				if (process.lifecycleStatus === "error") throw new Error("Process entered error lifecycle");
				return predicate(process);
			},
			{ description },
		);
	const wait = (id: string, turn: string | null, lifecycle = "waiting") =>
		waitForProcess(
			id,
			(p) => p.selectedTurnId === turn && p.lifecycleStatus === lifecycle,
			`${turn}/${lifecycle}`,
		);
	const action = (id: string, actionId: string) => harness.process(id).action(actionId);
	const armed = async (id: string) => {
		await wait(id, "deliver_change");
		await waitForValue(
			() =>
				externalSources
					.listArmed(provider === "github" ? GITHUB_PR_TERMINAL_KIND : GITLAB_MR_KIND)
					.some((s) => s.instanceId === id),
			Boolean,
			12000,
		);
	};
	const poll = async () => {
		clock += 180000;
		const result = await polling.poll();
		expect(result.errors).toEqual([]);
	};
	return {
		wait,
		waitForProcess,
		action,
		snapshot,
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
			let id: string;
			if (issueOrigin) {
				if (provider === "github") {
					const r = github.repo("team", "repo");
					const issue = github.createIssue(r, { title: "Update readme" });
					github.setIssueLabel(r, issue.number, "use-leitwerk", "developer");
				} else gitlab.createIssue(1, "Update readme");
				await poll();
				const process = await waitForValue(
					() => harness.processes().find((p) => p.processId === processId),
					Boolean,
					12000,
				);
				if (!process) throw new Error("No issue process");
				id = process.id;
			} else {
				id = (
					await harness.launch(`${processId}.ui_launcher`, {
						[`${provider}Profile`]: "team",
						repository: provider === "github" ? "team/repo" : "1",
						prompt: "Update readme",
					})
				).id;
			}
			await wait(id, "plan_decision");
			await action(id, "approve_plan");
			await wait(id, "implementation_decision");
			await action(id, "finalize_change");
			await armed(id);
			return id;
		},
		restart: () => harness.restart(),
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
for (const provider of ["github", "gitlab"] as const)
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
					`${JSON.parse(f.snapshot(id).process.paramsJson ?? "{}").workBranch}:README.md`,
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
			const before = f.snapshot(id).turns.map((t) => t.id);
			await f.restart();
			await f.armed(id);
			expect(f.snapshot(id).turns.map((t) => t.id)).toEqual(before);
			f.merge(id);
			await f.poll();
			await f.wait(id, null, "completed");
			expect(f.snapshot(id).projects).toHaveLength(1);
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
				f.harness.processes().filter((p) => p.processId === `${provider}_repo_change_process`),
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
			const writes = f.snapshot(id).writeReceipts;
			await f.restart();
			expect(f.snapshot(id).writeReceipts).toEqual(writes);
		}, 45000);
		it("settles feedback, preserves operator evidence over restart, and resumes waiting", async ({
			onTestFinished,
		}) => {
			const f = await fixture(provider, onTestFinished);
			const id = await f.launch();
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

for (const provider of ["github", "gitlab"] as const) {
	it(`${provider}: stops after three automatic CI repairs and does not replay dismissed evidence`, async ({
		onTestFinished,
	}) => {
		const f = await fixture(provider, onTestFinished);
		const id = await f.launch();
		for (let cycle = 1; cycle <= 3; cycle++) {
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
			expect(f.state(id).ciRecoveryCycles).toBe(cycle);
		}
		f.failCi(id);
		await f.poll();
		await f.wait(id, "ci_operator_action");
		expect(f.state(id).ciRecoveryCycles).toBe(3);
		await f.action(id, "resume_waiting");
		await f.armed(id);
		await f.poll();
		expect(f.snapshot(id).process).toMatchObject({
			selectedTurnId: "deliver_change",
			lifecycleStatus: "waiting",
		});
	}, 90000);
	it(`${provider}: aborts waiting delivery when its source trigger is removed`, async ({
		onTestFinished,
	}) => {
		const f = await fixture(provider, onTestFinished);
		const id = await f.launch(true);
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

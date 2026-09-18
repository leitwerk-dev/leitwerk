import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import codingExtension, { codingActionIds } from "@leitwerk-dev/coding";
import type { ProcessInstance } from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	FORGEJO_ISSUE_CANCELLED_KIND,
	FORGEJO_PR_CONFLICT_KIND,
	FORGEJO_PR_FEEDBACK_KIND,
	FORGEJO_PR_TERMINAL_KIND,
	ForgejoClient,
	type ForgejoIssue,
	type ForgejoPullRequest,
	setupForgejoIntegration,
} from "@leitwerk-dev/forgejo";
import { LocalForgejoAdapter } from "@leitwerk-dev/forgejo/testing";
import gitSshExtension from "@leitwerk-dev/git-ssh";
import type { CoreServerSetupDeps, LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import {
	createPollingTestExtension,
	fixtureModelProviders,
	postImmediateLaunch,
} from "@leitwerk-dev/test-support";
import {
	createIntegrationHarness,
	createProcessDriver,
	type IntegrationHarness,
	waitForValue,
} from "@leitwerk-dev/test-support/integration";
import { type createTestDiagnostics, LocalGit } from "@leitwerk-dev/test-support/local-git";
import {
	createInProcessWorkerSpawn,
	StubPiTreeHandleFactory,
} from "@leitwerk-dev/test-support/worker-testing";
import {
	setupWoodpeckerIntegration,
	WOODPECKER_PIPELINE_KIND,
	type WoodpeckerPipeline,
} from "@leitwerk-dev/woodpecker";
import { LocalWoodpeckerAdapter } from "@leitwerk-dev/woodpecker/testing";
import { createForgejoRepoChange } from "../index.js";

const PROCESS_ID = "forgejo_repo_change_process";
const MODEL_PROFILE_ID = "remote-change-fixture-model";
const PROFILE = "team";
const OWNER = "team";
const REPO = "service";
const WORK_BRANCH = "leitwerk/issue-42";
const ISSUE_URL = "https://forgejo.example/team/service/issues/42";
const PR_URL = "https://forgejo.example/__local#pr-7";
const FIXTURE_PREFIX = "leitwerk-forgejo-remote-change-";

const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";

export class TemporaryGitRemote {
	readonly barePath: string;
	readonly initialSha: string;
	readonly local: LocalGit;

	constructor(
		readonly root: string,
		seed?: TemporaryGitRemote,
	) {
		this.local = new LocalGit(root);
		if (seed) {
			this.barePath = path.join(realpathSync(root), "repositories", `${OWNER}--${REPO}.git`);
			cpSync(seed.barePath, this.barePath, { recursive: true });
			this.initialSha = seed.initialSha;
			return;
		}
		this.barePath = this.local.seed({
			owner: OWNER,
			name: REPO,
			files: {
				"README.md": "# Service\n",
				"k8s/deployment.yaml": [
					"apiVersion: apps/v1",
					"kind: Deployment",
					"metadata:",
					"  name: service",
					"spec:",
					"  replicas: 1",
					"  template:",
					"    spec:",
					"      containers:",
					"      - name: service",
					"        image: example/service:old",
					"",
				].join("\n"),
			},
		}).bare;
		this.initialSha = this.head("main");
	}

	head(branch: string): string {
		return this.local.head(this.barePath, `refs/heads/${branch}`);
	}

	show(branch: string, filePath: string): string {
		return this.local.run(this.barePath, ["show", `${branch}:${filePath}`]);
	}

	log(branch: string): string[] {
		const output = this.local.run(this.barePath, ["log", "--format=%s", branch]);
		return output ? output.split("\n") : [];
	}

	branches(): string[] {
		const output = this.local.run(this.barePath, [
			"for-each-ref",
			"--format=%(refname:short)",
			"refs/heads",
		]);
		return output ? output.split("\n").sort() : [];
	}
}

interface ProviderCall {
	method: string;
	args: readonly unknown[];
}

/** Observe calls without replacing the local adapters' behavior. */
function recordClient<T extends object>(client: T, calls: ProviderCall[]): T {
	return new Proxy(client, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				calls.push({ method: String(key), args });
				return Reflect.apply(value, receiver, args);
			};
		},
	});
}

function forgejoFixture(git: TemporaryGitRemote, botLogin = "leitwerk-bot") {
	const adapter = new LocalForgejoAdapter({
		root: git.root,
		baseUrl: "https://forgejo.example",
		seeds: [{ owner: OWNER, name: REPO, labels: ["use-leitwerk"] }],
	});
	adapter.state.sequence = Math.max(adapter.state.sequence, 6); // The fixture's first PR is #7.
	const calls: ProviderCall[] = [];
	const profile = { baseUrl: adapter.baseUrl, token: "fixture-token", botLogin };
	const client = recordClient(
		Object.assign(new ForgejoClient(profile), {
			...adapter.client(),
			profile,
			// Retain real identity resolution, including the authenticated-user lookup.
			resolveGitIdentity: ForgejoClient.prototype.resolveGitIdentity,
			getAuthenticatedUser: async () => ({ login: botLogin, full_name: "Leitwerk Bot" }),
		}),
		calls,
	);
	const data = adapter.repo(OWNER, REPO);
	return {
		calls,
		issues: data.issues,
		get replies() {
			return data.replies ?? [];
		},
		get reactions() {
			return data.reactions ?? [];
		},
		addFeedback(number = 7, kind: "conversation" | "inline" | "review" = "conversation") {
			return adapter.addFeedback(data, number, {
				kind,
				body: "Confirm that the service image is already updated.",
				author: "reviewer",
			});
		},
		pullRequests: data.pulls,
		profiles: () => [PROFILE],
		client(profile: string) {
			if (profile !== PROFILE) throw new Error(`Unexpected Forgejo profile '${profile}'`);
			return client;
		},
		exposeTriggeredIssue() {
			if (data.issues.some((issue) => issue.number === 42))
				throw new Error("Forgejo issue #42 is already exposed");
			data.issues.push({
				number: 42,
				title: "Update the service image",
				body: "Deploy the new service image and keep the Kubernetes manifest healthy.",
				state: "open",
				html_url: ISSUE_URL,
				updated_at: "2026-08-11T00:00:00.000Z",
				user: { login: "developer" },
				labels: structuredClone(data.labels),
			});
			adapter.save();
		},
		markPullRequestMerged: () => adapter.merge(data, 7),
		markPullRequestClosed() {
			const pr = this.pullRequest();
			pr.state = "closed";
			pr.merged = false;
			pr.merge_commit_sha = null;
			adapter.save();
			return pr;
		},
		issue(number = 42): ForgejoIssue {
			const issue = data.issues.find((issue) => issue.number === number);
			if (!issue) throw new Error(`Unknown Forgejo issue #${number}`);
			return issue;
		},
		comments: (number = 42) => (data.comments[number] ?? []).map((comment) => comment.body),
		pullRequest(number = 7): ForgejoPullRequest {
			const pr = data.pulls.find((pr) => pr.number === number);
			if (!pr) throw new Error(`Unknown Forgejo pull request #${number}`);
			pr.head.sha = git.head(pr.head.ref);
			return pr;
		},
	};
}

export interface PipelineFixture extends WoodpeckerPipeline {
	logs?: string;
}

function woodpeckerFixture(root: string) {
	const adapter = new LocalWoodpeckerAdapter({ root, baseUrl: "https://woodpecker.example" });
	adapter.seed(`${OWNER}/${REPO}`, 99);
	const calls: ProviderCall[] = [];
	const client = recordClient(adapter.client(), calls);
	const pipelines = adapter.state.repositories[0].pipelines;
	return {
		calls,
		pipelines,
		client(profile: string) {
			if (profile !== PROFILE) throw new Error(`Unexpected Woodpecker profile '${profile}'`);
			return client;
		},
		publish(pipeline: PipelineFixture) {
			const value = { logs: "", ...pipeline };
			const existing = pipelines.findIndex((candidate) => candidate.number === pipeline.number);
			if (existing >= 0) pipelines.splice(existing, 1, value);
			else pipelines.push(value);
			adapter.save();
		},
	};
}

export interface PiTurnRecord {
	kind: "plan" | "implementation" | "commit-message" | "ci-repair" | "feedback";
	sessionId: string;
	prompt: string;
	toolNames: readonly string[];
}

function treeText(factory: StubPiTreeHandleFactory): string {
	const session = factory.sessions.at(-1);
	if (!session) return "";
	return session
		.getBranch()
		.map((entry) => {
			if (entry.type === "custom_message") return entry.content;
			if (entry.type === "message" && entry.message) return entry.message.content;
			return "";
		})
		.filter((value): value is string => typeof value === "string")
		.join("\n\n");
}

interface PiFixtureOptions {
	ciRepairBlockedOnce?: boolean;
	feedbackOutcome?: "no_changes" | "cannot_repair" | "changes_ready";
	ciRestart?: boolean;
}

function markdownCall(toolName: string, markdown: string) {
	return { toolName, args: { markdown } };
}

function createPiFactory(
	records: PiTurnRecord[],
	git: LocalGit,
	options: PiFixtureOptions = {},
): StubPiTreeHandleFactory {
	const { ciRepairBlockedOnce = false, feedbackOutcome, ciRestart = false } = options;
	const factory = new StubPiTreeHandleFactory({
		recordSessionTrace: true,
		toolCallScriptResolver({ tools, promptText, sessionCwd, workspaceRoot }) {
			const cwd = sessionCwd ?? workspaceRoot;
			if (!cwd) throw new Error("Fixture Pi session has no workspace cwd");
			const replaceWorkspaceText = (relativePath: string, oldText: string, newText: string) => {
				const filePath = path.join(cwd, relativePath);
				const current = readFileSync(filePath, "utf8");
				if (current.includes(newText)) return;
				if (!current.includes(oldText))
					throw new Error(`Fixture edit could not find expected text in ${relativePath}`);
				writeFileSync(filePath, current.replace(oldText, newText), "utf8");
			};
			const toolNames = tools.map((tool) => tool.name);
			const names = new Set(toolNames);
			const prompt = [treeText(factory), promptText].filter(Boolean).join("\n\n");
			const sessionId = factory.sessions.at(-1)?.sessionId;
			if (!sessionId) throw new Error("Pi resolver ran without a fixture session");

			if (names.has("plan_saved")) {
				records.push({ kind: "plan", sessionId, prompt, toolNames });
				return {
					thinkingChunks: ["Plan the manifest change before implementation."],
					calls: [
						{
							toolName: "plan_saved",
							args: {
								markdown:
									"# Plan\n\n1. Update `k8s/deployment.yaml`.\n2. Validate the published change.",
								summary: "Update the service deployment image",
								acceptanceCriteria: ["The manifest uses the new service image"],
							},
						},
					],
				};
			}

			if (names.has("changes_ready") && existsSync(path.join(cwd, ".git/rebase-merge"))) {
				const record = JSON.parse(
					readFileSync(path.join(cwd, ".git/leitwerk-rebase.json"), "utf8"),
				);
				if (!record.originalHead || !record.branch)
					throw new Error("Missing retained publication lease");
				while (existsSync(path.join(cwd, ".git/rebase-merge"))) {
					const conflicts = git
						.run(cwd, ["diff", "--name-only", "--diff-filter=U"])
						.split("\n")
						.filter(Boolean);
					for (const file of conflicts) {
						if (file !== "k8s/deployment.yaml") throw new Error(`Unexpected conflict: ${file}`);
						const base = git.run(cwd, ["show", ":2:k8s/deployment.yaml"]);
						writeFileSync(
							path.join(cwd, file),
							`${base.replace("image: example/service:base", "image: example/service:new")}\n`,
						);
						git.run(cwd, ["add", "--", file]);
					}
					git.run(cwd, ["-c", "core.editor=true", "rebase", "--continue"]);
				}
				return markdownCall(
					"changes_ready",
					"Resolved manifest conflict, retaining base annotations and requested image.",
				);
			}

			if (
				feedbackOutcome &&
				names.has("changes_ready") &&
				names.has("forgejo_list_pull_request_feedback")
			) {
				records.push({ kind: "feedback", sessionId, prompt, toolNames });
				if (feedbackOutcome === "changes_ready")
					replaceWorkspaceText(
						"README.md",
						"# Service\n",
						"# Service\n\nReviewed deployment configuration.\n",
					);
				return markdownCall(
					feedbackOutcome,
					"The service image is already updated; no repository edit is justified.",
				);
			}

			if (names.has("changes_ready") && names.has("woodpecker_get_step_logs")) {
				const blocked = ciRepairBlockedOnce && !records.some((turn) => turn.kind === "ci-repair");
				records.push({ kind: "ci-repair", sessionId, prompt, toolNames });
				const diagnosticCalls = [
					{
						toolName: "woodpecker_get_pipeline",
						args: { projectKey: "repo", pipelineNumber: 1 },
					},
					{
						toolName: "woodpecker_get_step_logs",
						args: {
							projectKey: "repo",
							pipelineNumber: 1,
							stepId: 10,
							tailLines: 100,
							maxBytes: 16_384,
						},
					},
				];
				if (ciRestart)
					return {
						calls: [
							...diagnosticCalls,
							{
								toolName: "woodpecker_restart_pipeline",
								args: {
									projectKey: "repo",
									pipelineNumber: 1,
									diagnosis: "Transient runner failure",
									logEvidence: "Inspected runner unavailable in pipeline logs",
								},
							},
							markdownCall(
								"no_changes",
								"Restarted pipeline after diagnosis without repository changes.",
							),
						],
					};
				if (blocked)
					return markdownCall(
						"cannot_repair",
						"Operator approval is required before changing the readiness probe.",
					);
				replaceWorkspaceText(
					"k8s/deployment.yaml",
					"        image: example/service:new\n",
					"        image: example/service:new\n        readinessProbe:\n          httpGet:\n            path: /ready\n            port: 8080\n",
				);
				return {
					calls: [
						{
							toolName: "woodpecker_lookup_repository",
							args: { projectKey: "repo" },
						},
						...diagnosticCalls,
						markdownCall("changes_ready", "Added the required readiness probe."),
					],
				};
			}

			if (
				prompt.includes("Implement this requested change:") &&
				prompt.includes("Follow this plan:")
			) {
				git.run(cwd, ["config", "user.name", "Leitwerk Fixture"]);
				git.run(cwd, ["config", "user.email", "fixture@leitwerk.invalid"]);
				replaceWorkspaceText(
					"k8s/deployment.yaml",
					"        image: example/service:old",
					"        image: example/service:new",
				);
				records.push({ kind: "implementation", sessionId, prompt, toolNames });
				return markdownCall(
					"markdown_result",
					"## Implementation\n\nUpdated the service deployment image.",
				);
			}

			if (names.has("markdown_result") || prompt.includes("commit message")) {
				records.push({ kind: "commit-message", sessionId, prompt, toolNames });
				return markdownCall("markdown_result", "feat: update service deployment image");
			}

			throw new Error(`Unexpected fixture Pi turn with tools: ${toolNames.join(", ")}`);
		},
	});
	return factory;
}

const fixtureModelProviderExtension: LeitwerkExtensionModule = {
	manifest: { id: "remote-change-fixture-provider", version: "1.0.0" },
	modelProviders: fixtureModelProviders({
		id: "remote-change-fixture-provider",
		modelId: "fixture-model",
		server: true,
	}),
};

export function remoteState(process: ProcessInstance): Record<string, unknown> {
	const state = JSON.parse(process.stateJson ?? "{}") as Record<string, unknown>;
	const extensionState = state.extensionState as Record<string, unknown> | undefined;
	return (extensionState?.forgejoRepoChange as Record<string, unknown> | undefined) ?? {};
}

export type RemoteRepoChangeFixture = Awaited<ReturnType<typeof createRemoteRepoChangeFixture>>;

export async function createRemoteRepoChangeFixture(
	dockerPreflight: (timeoutMs: number) => Promise<void> = async () => {},
	options: PiFixtureOptions & {
		docker?: boolean;
		botLogin?: string;
		diagnostics?: ReturnType<typeof createTestDiagnostics>;
		seed?: TemporaryGitRemote;
	} = {},
) {
	const trace = options.diagnostics;
	trace?.mark("fixture.create.start");
	const root = await mkdtemp(path.join(tmpdir(), FIXTURE_PREFIX));
	let runningHarness: IntegrationHarness | undefined;
	async function removeFixtureRoot() {
		if (!root.startsWith(path.join(tmpdir(), FIXTURE_PREFIX)))
			throw new Error(`Refusing to remove unvalidated fixture root '${root}'`);
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		trace?.mark("fixture.close.files.end");
	}
	async function close() {
		try {
			trace?.mark("fixture.close.app.start");
			await runningHarness?.close();
			trace?.mark("fixture.close.app.end");
		} finally {
			await removeFixtureRoot();
		}
	}

	try {
		trace?.mark("fixture.git.start");
		const temporaryGit = new TemporaryGitRemote(root, options.seed);
		trace?.mark("fixture.git.end");
		let forgejo = forgejoFixture(temporaryGit, options.botLogin);
		let woodpecker = woodpeckerFixture(root);
		const piTurns: PiTurnRecord[] = [];
		let piFactory = createPiFactory(piTurns, temporaryGit.local, options);
		let pollTime = Date.now();
		const forgejoProvider = createPollingTestExtension({ id: "forgejo", version: "1.0.0" }, (api) =>
			setupForgejoIntegration(
				api,
				forgejo,
				{ enabled: false, defaultLabels: [] },
				{
					now: () => pollTime,
				},
			),
		);
		const woodpeckerProvider = createPollingTestExtension(
			{ id: "woodpecker", version: "1.0.0" },
			(api) =>
				// Each explicit poll advances past the provider's throttle interval.
				setupWoodpeckerIntegration(api, woodpecker, { now: () => (pollTime += 60_000) }),
		);

		async function checkedPoll(provider: typeof forgejoProvider, errorPrefix: string) {
			const result = await provider.poll();
			if (result.errors.length) throw new Error(errorPrefix + result.errors.join(", "));
			return result;
		}

		let generation = 0;
		async function start(retainedConfig?: IntegrationHarness["config"]) {
			const appGeneration = ++generation;
			trace?.mark("fixture.app.start", { appGeneration });
			const extensionCatalog = await buildExtensionCatalogFromModules([
				codingExtension,
				gitSshExtension,
				forgejoProvider,
				woodpeckerProvider,
				createForgejoRepoChange({ docker: options.docker ?? true }).extension,
				fixtureModelProviderExtension,
			]);

			await mkdir(path.join(root, "storage", "trees"), { recursive: true });
			await mkdir(path.join(root, "storage", "workspaces"), { recursive: true });
			const spawn = createInProcessWorkerSpawn({
				extensionCatalog,
				piFactory,
				onConnectionDiagnostic: (event) =>
					trace?.mark("worker.connection", { appGeneration, ...event }),
			});
			const tracedSpawn: typeof spawn = (...args) => {
				const child = spawn(...args);
				const env = args[2]?.env;
				const identity = {
					appGeneration,
					workerId: env?.LEITWERK_WORKER_ID,
					instanceId: env?.LEITWERK_INSTANCE_ID,
					pid: child.pid,
				};
				trace?.mark("worker.spawn", identity);
				child.on("exit", (code, signal) =>
					trace?.mark("worker.exit", { ...identity, code, signal }),
				);
				const kill = child.kill.bind(child);
				child.kill = (signal) => {
					trace?.mark("worker.kill", { ...identity, signal });
					return kill(signal);
				};
				return child;
			};
			const result = await createIntegrationHarness({
				// This fixture advances each provider poll explicitly.
				backgroundServices: false,
				config: retainedConfig,
				extensionCatalog,
				appOverrides: {
					// This fixture simulates worker tools; live Docker is covered by the opt-in runtime gate.
					localWorkerDockerPreflightImpl: dockerPreflight,
					localWorkerSpawnImpl: trace ? tracedSpawn : spawn,
				},
				configOverride(config) {
					if (retainedConfig) return;
					if (!config.local_worker) throw new Error("Fixture requires local worker configuration");
					config.local_worker.allow_host_docker = options.docker ?? true;
					config.storage.sqlite_path = path.join(root, "storage", "leitwerk.sqlite");
					config.storage.tree_files_dir = path.join(root, "storage", "trees");
					config.storage.process_workspaces_dir = path.join(root, "storage", "workspaces");
					config.pi.agent_dir = path.join(root, "storage", "pi-agent");
					config.pi.model_profiles = [
						{
							id: MODEL_PROFILE_ID,
							provider: "remote-change-fixture-provider",
							model_id: "fixture-model",
							thinking_level: "off",
						},
					];
					config.pi.process_title_generation.model_profile = MODEL_PROFILE_ID;
					config.process_configs = {
						[PROCESS_ID]: {
							default_model_profile: MODEL_PROFILE_ID,
							turn_configs: {},
							watchers: {
								use_leitwerk: {
									enabled: true,
									profile: PROFILE,
									poll_interval: "30s",
									labels: { trigger: "use-leitwerk", done: "leitwerk-done" },
								},
							},
						},
					};
					config.extensions["git-ssh"] = {
						credentials: {
							[PROFILE]: {
								private_key: privateKey,
								known_hosts: "forgejo.example ssh-ed25519 AAAA",
							},
						},
					};
				},
			});
			trace?.mark("fixture.app.ready", { appGeneration, address: result.address });
			return result;
		}
		let harness = await start();
		runningHarness = harness;
		const { action, wait, waitForProcess } = createProcessDriver(() => harness.ctx);
		const subscriptions = (id: string) => {
			const sources = harness.ctx.deps
				.externalSourceService as CoreServerSetupDeps["externalSources"];
			return [
				WOODPECKER_PIPELINE_KIND,
				FORGEJO_PR_TERMINAL_KIND,
				FORGEJO_PR_FEEDBACK_KIND,
				FORGEJO_PR_CONFLICT_KIND,
				FORGEJO_ISSUE_CANCELLED_KIND,
			].flatMap((kind) =>
				sources
					.listArmed(kind)
					.filter((armed) => armed.instanceId === id)
					.map((armed) => ({ kind, id: armed.id, resolved: armed.resolved })),
			);
		};
		const waitForTurn: typeof wait = async (id, turn, ...options) => {
			const process = await wait(id, turn, ...options);
			if (turn === "deliver_change" && process.lifecycleStatus === "waiting") {
				// One-shot provider polls must not race asynchronous subscription arming.
				await waitForValue(
					() =>
						[
							WOODPECKER_PIPELINE_KIND,
							FORGEJO_PR_TERMINAL_KIND,
							FORGEJO_PR_FEEDBACK_KIND,
							FORGEJO_PR_CONFLICT_KIND,
						].every((kind) => subscriptions(id).some((armed) => armed.kind === kind)),
					Boolean,
					12000,
				);
			}
			return process;
		};
		return {
			get harness() {
				return harness;
			},
			get forgejo() {
				return forgejo;
			},
			get woodpecker() {
				return woodpecker;
			},
			git: temporaryGit,
			get piFactory() {
				return piFactory;
			},
			subscriptions,
			async restart(whileStopped?: () => Promise<void>) {
				const config = harness.config;
				trace?.mark("fixture.restart.close.start");
				await harness.close();
				trace?.mark("fixture.restart.close.end");
				await whileStopped?.();
				forgejo = forgejoFixture(temporaryGit, options.botLogin);
				woodpecker = woodpeckerFixture(root);
				piFactory = createPiFactory(piTurns, temporaryGit.local, options);
				harness = await start(config);
				runningHarness = harness;
				await harness.ctx.startBackgroundServices();
			},
			piTurns: piTurns as readonly PiTurnRecord[],
			root,
			async launchTicketlessChange(prompt: string, extraInput: Record<string, unknown> = {}) {
				const response = await postImmediateLaunch(
					harness.address,
					"forgejo_repo_change_process.ui_launcher",
					{
						launcherInput: {
							forgejoProfile: PROFILE,
							repository: `${OWNER}/${REPO}`,
							prompt,
							...extraInput,
						},
					},
				);
				if (response.status !== 201) {
					throw new Error(
						`Ticketless launch failed with ${response.status}: ${await response.text()}`,
					);
				}
				const body = (await response.json()) as { process?: { id?: string } };
				const instanceId = body.process?.id;
				if (!instanceId) throw new Error("Ticketless launch did not return a process id");
				await waitForTurn(instanceId, "plan_decision");
				return instanceId;
			},
			async exposeTriggeredIssue() {
				forgejo.exposeTriggeredIssue();
				const pollResult = await checkedPoll(forgejoProvider, "Forgejo fixture poll failed: ");
				if (pollResult.created.length === 0) {
					throw new Error(
						`Forgejo fixture poll did not create a process: ${JSON.stringify(pollResult)}`,
					);
				}
				const launched = await waitForValue(
					() =>
						harness.ctx.deps.processes
							.listAll()
							.filter((process) => process.processId === PROCESS_ID),
					(processes) => processes.length === 1,
					12_000,
				);
				const instanceId = launched[0]?.id;
				if (!instanceId)
					throw new Error("Forgejo poll did not launch the repository-change process");
				await waitForTurn(instanceId, "plan_decision");
				return instanceId;
			},
			async approvePlan(instanceId: string) {
				await action(instanceId, codingActionIds.approvePlan);
				await waitForTurn(instanceId, "implementation_decision");
			},
			async approveImplementation(instanceId: string) {
				await action(instanceId, codingActionIds.finalizeChange);
				await waitForTurn(instanceId, "deliver_change");
			},
			async publishChange(instanceId: string): Promise<string> {
				await this.approvePlan(instanceId);
				await this.approveImplementation(instanceId);
				return instanceId;
			},
			action,
			async conflictBase() {
				const directory = path.join(root, "conflicting-base");
				mkdirSync(directory);
				const git = (...args: string[]) => temporaryGit.local.run(directory, args);
				git("clone", temporaryGit.barePath, ".");
				const file = path.join(directory, "k8s/deployment.yaml");
				writeFileSync(
					file,
					`${readFileSync(file, "utf8").replace(
						"image: example/service:old",
						"image: example/service:base",
					)}# Base update: preserve deployment notes\n`,
				);
				git("add", ".");
				git("commit", "-m", "docs: conflicting base update");
				git("push", "origin", "main");
				const baseSha = temporaryGit.head("main");
				pollTime += 180_000;
				await checkedPoll(forgejoProvider, "");
				return baseSha;
			},
			async pollFeedback() {
				// Advance beyond both the feedback quiet period and provider throttle.
				pollTime += 180_000;
				await checkedPoll(forgejoProvider, "Forgejo fixture poll failed: ");
			},
			async publishPipeline(input: PipelineFixture) {
				woodpecker.publish(input);
				await checkedPoll(woodpeckerProvider, "Woodpecker fixture poll failed: ");
			},
			async markPullRequestMerged() {
				forgejo.markPullRequestMerged();
				await forgejoProvider.poll();
			},
			async markPullRequestClosed() {
				forgejo.markPullRequestClosed();
				await forgejoProvider.poll();
			},
			async removeSourceTrigger() {
				const issue = forgejo.issue();
				await forgejo.client(PROFILE).updateIssue(OWNER, REPO, issue.number, {
					labels: issue.labels
						.filter((label) => label.name !== "use-leitwerk")
						.map((label) => label.id),
				});
				pollTime += 60_000;
				await checkedPoll(forgejoProvider, "Forgejo fixture poll failed: ");
			},
			waitForTurn,
			async waitForHeadChange(instanceId: string, previousSha: string) {
				const process = await waitForProcess(
					instanceId,
					(candidate) => {
						const headSha = remoteState(candidate).headSha;
						return typeof headSha === "string" && headSha !== previousSha;
					},
					`a remote head different from ${previousSha}`,
				);
				return String(remoteState(process).headSha);
			},
			waitForCompleted: (id: string) => waitForTurn(id, null, "completed"),
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}

export const remoteRepoChangeFixtureConstants = {
	processId: PROCESS_ID,
	issueUrl: ISSUE_URL,
	prUrl: PR_URL,
	owner: OWNER,
	repo: REPO,
	workBranch: WORK_BRANCH,
} as const;

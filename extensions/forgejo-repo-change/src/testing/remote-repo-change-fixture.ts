import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import codingExtension, { codingActionIds } from "@leitwerk-dev/coding";
import type { ProcessInstance } from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	ForgejoClient,
	type ForgejoIntegration,
	type ForgejoIssue,
	type ForgejoLabel,
	type ForgejoPullRequest,
	type ForgejoRepository,
	forgejoIssueWatcherSource,
	setupForgejoIntegration,
} from "@leitwerk-dev/forgejo";
import gitSshExtension from "@leitwerk-dev/git-ssh";
import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
	type LeitwerkExtensionModule,
	type PiPromptOptions,
} from "@leitwerk-dev/process-sdk";
import { postImmediateLaunch } from "@leitwerk-dev/test-support";
import {
	createIntegrationHarness,
	type IntegrationHarness,
	waitForValue,
} from "@leitwerk-dev/test-support/integration";
import {
	createInProcessWorkerSpawn,
	StubPiTreeHandleFactory,
} from "@leitwerk-dev/test-support/worker-testing";
import {
	setupWoodpeckerIntegration,
	WoodpeckerClient,
	type WoodpeckerIntegration,
	type WoodpeckerPipeline,
	type WoodpeckerRepository,
} from "@leitwerk-dev/woodpecker";
import { createForgejoRepoChange } from "../index.js";

const PROCESS_ID = "forgejo_repo_change_process";
const MODEL_PROFILE_ID = "remote-change-fixture-model";
const PROFILE = "team";
const OWNER = "team";
const REPO = "service";
const WORK_BRANCH = "leitwerk/issue-42";
const ISSUE_URL = "https://forgejo.example/team/service/issues/42";
const PR_URL = "https://forgejo.example/team/service/pulls/7";
const FIXTURE_PREFIX = "leitwerk-forgejo-remote-change-";

const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";

function git(args: readonly string[]): string {
	return execFileSync("git", [...args], { encoding: "utf8" }).trim();
}

export class TemporaryGitRemote {
	readonly sourcePath: string;
	readonly barePath: string;
	readonly initialSha: string;

	private constructor(
		readonly root: string,
		sourcePath: string,
		barePath: string,
		initialSha: string,
	) {
		this.sourcePath = sourcePath;
		this.barePath = barePath;
		this.initialSha = initialSha;
	}

	static async create(root: string): Promise<TemporaryGitRemote> {
		const sourcePath = path.join(root, "source");
		const barePath = path.join(root, "remote.git");
		await mkdir(path.join(sourcePath, "k8s"), { recursive: true });
		await writeFile(
			path.join(sourcePath, "k8s", "deployment.yaml"),
			[
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
			"utf8",
		);
		await writeFile(path.join(sourcePath, "README.md"), "# Service\n", "utf8");

		git(["init", "--initial-branch=main", sourcePath]);
		git(["-C", sourcePath, "config", "user.name", "Leitwerk Fixture"]);
		git(["-C", sourcePath, "config", "user.email", "fixture@leitwerk.invalid"]);
		git(["-C", sourcePath, "add", "README.md", "k8s/deployment.yaml"]);
		git(["-C", sourcePath, "commit", "-m", "chore: seed fixture repository"]);
		git(["init", "--bare", barePath]);
		git(["-C", sourcePath, "remote", "add", "origin", barePath]);
		git(["-C", sourcePath, "push", "--set-upstream", "origin", "main"]);
		git(["--git-dir", barePath, "symbolic-ref", "HEAD", "refs/heads/main"]);
		const initialSha = git(["--git-dir", barePath, "rev-parse", "refs/heads/main"]);
		return new TemporaryGitRemote(root, sourcePath, barePath, initialSha);
	}

	head(branch: string): string {
		return git(["--git-dir", this.barePath, "rev-parse", `refs/heads/${branch}`]);
	}

	show(branch: string, filePath: string): string {
		return git(["--git-dir", this.barePath, "show", `${branch}:${filePath}`]);
	}

	log(branch: string): string[] {
		const output = git(["--git-dir", this.barePath, "log", "--format=%s", branch]);
		return output ? output.split("\n") : [];
	}

	branches(): string[] {
		const output = git([
			"--git-dir",
			this.barePath,
			"for-each-ref",
			"--format=%(refname:short)",
			"refs/heads",
		]);
		return output ? output.split("\n").sort() : [];
	}
}

export interface ForgejoCall {
	method: string;
	args: readonly unknown[];
}

class MockForgejoClient extends ForgejoClient {
	constructor(private readonly owner: MockForgejo) {
		super({
			baseUrl: "https://forgejo.example",
			token: "fixture-token",
			botLogin: owner.botLogin,
		});
	}

	override async getAuthenticatedUser() {
		this.owner.record("getAuthenticatedUser");
		return { login: this.owner.botLogin, full_name: "Leitwerk Bot" };
	}

	override async listRepositories(): Promise<ForgejoRepository[]> {
		this.owner.record("listRepositories");
		return [this.owner.repository];
	}

	override async listOpenIssues(owner: string, repo: string): Promise<ForgejoIssue[]> {
		this.owner.assertRepository(owner, repo);
		this.owner.record("listOpenIssues", owner, repo);
		return [...this.owner.issues.values()].filter((issue) => issue.state === "open");
	}

	override async getIssue(owner: string, repo: string, number: number): Promise<ForgejoIssue> {
		this.owner.assertRepository(owner, repo);
		this.owner.record("getIssue", owner, repo, number);
		return this.owner.requireIssue(number);
	}

	override async updateIssue(
		owner: string,
		repo: string,
		number: number,
		patch: Record<string, unknown>,
	): Promise<ForgejoIssue> {
		this.owner.assertRepository(owner, repo);
		this.owner.record("updateIssue", owner, repo, number, { ...patch });
		const issue = this.owner.requireIssue(number);
		if (Array.isArray(patch.labels)) {
			issue.labels = patch.labels.map((value) => {
				const label = this.owner.labels.find(
					(candidate) => candidate.id === value || candidate.name === value,
				);
				if (!label) throw new Error(`Unknown Forgejo label '${String(value)}'`);
				return { id: label.id, name: label.name };
			});
		}
		if (typeof patch.state === "string") issue.state = patch.state;
		issue.updated_at = new Date().toISOString();
		return issue;
	}

	override async listLabels(owner: string, repo: string): Promise<ForgejoLabel[]> {
		this.owner.assertRepository(owner, repo);
		this.owner.record("listLabels", owner, repo);
		return [...this.owner.labels];
	}

	override async createLabel(
		owner: string,
		repo: string,
		name: string,
		color = "2da44e",
	): Promise<ForgejoLabel> {
		this.owner.assertRepository(owner, repo);
		this.owner.record("createLabel", owner, repo, name, color);
		const existing = this.owner.labels.find((label) => label.name === name);
		if (existing) return existing;
		const created = { id: 2, name, color };
		this.owner.labels.push(created);
		return created;
	}

	override async addIssueComment(
		owner: string,
		repo: string,
		number: number,
		body: string,
	): Promise<unknown> {
		this.owner.assertRepository(owner, repo);
		this.owner.record("addIssueComment", owner, repo, number, body);
		this.owner.requireIssue(number);
		const comments = this.owner.issueComments.get(number) ?? [];
		comments.push(body);
		this.owner.issueComments.set(number, comments);
		return { id: comments.length, body };
	}

	override async createPullRequest(
		owner: string,
		repo: string,
		input: { title: string; body: string; head: string; base: string },
	): Promise<ForgejoPullRequest> {
		this.owner.assertRepository(owner, repo);
		this.owner.record("createPullRequest", owner, repo, { ...input });
		if (this.owner.pullRequests.size > 0) throw new Error("Fixture only supports one pull request");
		const created: ForgejoPullRequest = {
			number: 7,
			title: input.title,
			body: input.body,
			state: "open",
			merged: false,
			merge_commit_sha: null,
			html_url: PR_URL,
			head: { ref: input.head, sha: this.owner.git.head(input.head) },
			base: { ref: input.base, sha: this.owner.git.initialSha },
		};
		this.owner.pullRequests.set(created.number, created);
		return created;
	}

	override async getPullRequest(
		owner: string,
		repo: string,
		number: number,
	): Promise<ForgejoPullRequest> {
		this.owner.assertRepository(owner, repo);
		this.owner.record("getPullRequest", owner, repo, number);
		return this.owner.requirePullRequest(number);
	}

	override async listPullRequests(
		owner: string,
		repo: string,
		state = "open",
	): Promise<ForgejoPullRequest[]> {
		this.owner.assertRepository(owner, repo);
		this.owner.record("listPullRequests", owner, repo, state);
		return [...this.owner.pullRequests.values()].filter(
			(pr) => state === "all" || pr.state === state,
		);
	}
}

export class MockForgejo implements ForgejoIntegration {
	readonly repository: ForgejoRepository;
	readonly issues = new Map<number, ForgejoIssue>();
	readonly labels: ForgejoLabel[] = [{ id: 1, name: "use-leitwerk", color: "0052cc" }];
	readonly issueComments = new Map<number, string[]>();
	readonly pullRequests = new Map<number, ForgejoPullRequest>();
	readonly calls: ForgejoCall[] = [];
	private readonly mockClient: MockForgejoClient;

	constructor(
		readonly git: TemporaryGitRemote,
		readonly botLogin = "leitwerk-bot",
	) {
		this.repository = {
			id: 23,
			name: REPO,
			full_name: `${OWNER}/${REPO}`,
			ssh_url: git.barePath,
			html_url: "https://forgejo.example/team/service",
			default_branch: "main",
			owner: { login: OWNER },
		};
		this.mockClient = new MockForgejoClient(this);
	}

	profiles(): readonly string[] {
		return [PROFILE];
	}

	client(profile: string): ForgejoClient {
		if (profile !== PROFILE) throw new Error(`Unexpected Forgejo profile '${profile}'`);
		return this.mockClient;
	}

	exposeTriggeredIssue(): void {
		if (this.issues.has(42)) throw new Error("Forgejo issue #42 is already exposed");
		this.issues.set(42, {
			number: 42,
			title: "Update the service image",
			body: "Deploy the new service image and keep the Kubernetes manifest healthy.",
			state: "open",
			html_url: ISSUE_URL,
			updated_at: "2026-08-11T00:00:00.000Z",
			user: { login: "developer" },
			labels: [{ id: 1, name: "use-leitwerk" }],
		});
	}

	markPullRequestMerged(): ForgejoPullRequest {
		const pr = this.requirePullRequest(7);
		pr.state = "closed";
		pr.merged = true;
		pr.merge_commit_sha = "0123456789abcdef0123456789abcdef01234567";
		return pr;
	}

	markPullRequestClosed(): ForgejoPullRequest {
		const pr = this.requirePullRequest(7);
		pr.state = "closed";
		pr.merged = false;
		pr.merge_commit_sha = null;
		return pr;
	}

	issue(number = 42): ForgejoIssue {
		return this.requireIssue(number);
	}

	pullRequest(number = 7): ForgejoPullRequest {
		return this.requirePullRequest(number);
	}

	comments(number = 42): readonly string[] {
		return [...(this.issueComments.get(number) ?? [])];
	}

	record(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
	}

	assertRepository(owner: string, repo: string): void {
		if (owner !== OWNER || repo !== REPO) {
			throw new Error(`Unexpected Forgejo repository '${owner}/${repo}'`);
		}
	}

	requireIssue(number: number): ForgejoIssue {
		const issue = this.issues.get(number);
		if (!issue) throw new Error(`Unknown Forgejo issue #${number}`);
		return issue;
	}

	requirePullRequest(number: number): ForgejoPullRequest {
		const pr = this.pullRequests.get(number);
		if (!pr) throw new Error(`Unknown Forgejo pull request #${number}`);
		pr.head.sha = this.git.head(pr.head.ref);
		return pr;
	}
}

export interface PipelineFixture extends WoodpeckerPipeline {
	stepLogs?: Map<number, string>;
}

export interface WoodpeckerCall {
	method: string;
	args: readonly unknown[];
}

class MockWoodpeckerClient extends WoodpeckerClient {
	constructor(private readonly owner: MockWoodpecker) {
		super({ baseUrl: "https://woodpecker.example", token: "fixture-token" });
	}

	override async lookupRepository(fullName: string): Promise<WoodpeckerRepository> {
		this.owner.record("lookupRepository", fullName);
		if (fullName !== `${OWNER}/${REPO}`) {
			throw new Error(`Unexpected Woodpecker repository '${fullName}'`);
		}
		return this.owner.repository;
	}

	override async listPipelines(repoId: number): Promise<WoodpeckerPipeline[]> {
		this.owner.assertRepositoryId(repoId);
		this.owner.record("listPipelines", repoId);
		return [...this.owner.pipelines];
	}

	override async getPipeline(repoId: number, number: number): Promise<WoodpeckerPipeline> {
		this.owner.assertRepositoryId(repoId);
		this.owner.record("getPipeline", repoId, number);
		return this.owner.requirePipeline(number);
	}

	override async getStepLogs(
		repoId: number,
		number: number,
		stepId: number,
		tailLines = 400,
		maxBytes = 262_144,
	): Promise<{ logs: string; truncated: boolean }> {
		this.owner.assertRepositoryId(repoId);
		this.owner.record("getStepLogs", repoId, number, stepId, tailLines, maxBytes);
		const logs = this.owner.requirePipeline(number).stepLogs?.get(stepId);
		if (logs === undefined) {
			throw new Error(`No logs for Woodpecker pipeline #${number} step ${stepId}`);
		}
		return { logs, truncated: false };
	}
}

export class MockWoodpecker implements WoodpeckerIntegration {
	readonly repository: WoodpeckerRepository = {
		id: 99,
		full_name: `${OWNER}/${REPO}`,
	};
	readonly pipelines: PipelineFixture[] = [];
	readonly calls: WoodpeckerCall[] = [];
	private readonly mockClient = new MockWoodpeckerClient(this);

	client(profile: string): WoodpeckerClient {
		if (profile !== PROFILE) throw new Error(`Unexpected Woodpecker profile '${profile}'`);
		return this.mockClient;
	}

	publish(pipeline: PipelineFixture): void {
		const existing = this.pipelines.findIndex((candidate) => candidate.number === pipeline.number);
		if (existing >= 0) this.pipelines.splice(existing, 1, pipeline);
		else this.pipelines.push(pipeline);
	}

	record(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
	}

	assertRepositoryId(repoId: number): void {
		if (repoId !== this.repository.id) {
			throw new Error(`Unexpected Woodpecker repository id ${repoId}`);
		}
	}

	requirePipeline(number: number): PipelineFixture {
		const pipeline = this.pipelines.find((candidate) => candidate.number === number);
		if (!pipeline) throw new Error(`Unknown Woodpecker pipeline #${number}`);
		return pipeline;
	}
}

export interface PiTurnRecord {
	kind: "plan" | "implementation" | "commit-message" | "ci-repair";
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

class FixturePiTreeHandleFactory extends StubPiTreeHandleFactory {
	private sessionCwd: string | null = null;
	private toolCallSequence = 0;

	override async createPrimaryTreeHandle(
		opts: Parameters<StubPiTreeHandleFactory["createPrimaryTreeHandle"]>[0],
	) {
		this.sessionCwd = opts.sessionCwd ?? opts.workspaceRoot;
		const handle = await super.createPrimaryTreeHandle(opts);
		const withPiIdentity = (options: PiPromptOptions | undefined): PiPromptOptions | undefined => {
			if (!options?.tools?.length) return options;
			return {
				...options,
				tools: options.tools.map((tool) => ({
					...tool,
					execute: (args) =>
						tool.execute(args, {
							toolCallId: `fixture-pi-tool-${++this.toolCallSequence}`,
							signal: new AbortController().signal,
						}),
				})),
			};
		};
		const prompt = handle.prompt.bind(handle);
		const promptLiteral = handle.promptLiteral.bind(handle);
		const promptCustom = handle.promptCustom.bind(handle);
		const continueTurn = handle.continueTurn.bind(handle);
		handle.prompt = (text, options) => prompt(text, withPiIdentity(options));
		handle.promptLiteral = (text, options) => promptLiteral(text, withPiIdentity(options));
		handle.promptCustom = (input, options) => promptCustom(input, withPiIdentity(options));
		handle.continueTurn = (options) => continueTurn(withPiIdentity(options));
		return handle;
	}

	configureGitIdentity(): void {
		const cwd = this.requireSessionCwd();
		git(["-C", cwd, "config", "user.name", "Leitwerk Fixture"]);
		git(["-C", cwd, "config", "user.email", "fixture@leitwerk.invalid"]);
	}

	replaceWorkspaceText(relativePath: string, oldText: string, newText: string): void {
		const filePath = path.join(this.requireSessionCwd(), relativePath);
		const current = readFileSync(filePath, "utf8");
		if (current.includes(newText)) return;
		if (!current.includes(oldText)) {
			throw new Error(`Fixture edit could not find expected text in ${relativePath}`);
		}
		writeFileSync(filePath, current.replace(oldText, newText), "utf8");
	}

	private requireSessionCwd(): string {
		if (!this.sessionCwd) throw new Error("Fixture Pi session has no workspace cwd");
		return this.sessionCwd;
	}
}

function createPiFactory(records: PiTurnRecord[]): StubPiTreeHandleFactory {
	let factory: FixturePiTreeHandleFactory;
	factory = new FixturePiTreeHandleFactory({
		toolCallScriptResolver({ tools, promptText }) {
			const toolNames = tools.map((tool) => tool.name);
			const names = new Set(toolNames);
			const prompt = [treeText(factory), promptText].filter(Boolean).join("\n\n");
			const sessionId = factory.sessions.at(-1)?.sessionId;
			if (!sessionId) throw new Error("Pi resolver ran without a fixture session");

			if (names.has("plan_saved")) {
				records.push({ kind: "plan", sessionId, prompt, toolNames });
				return {
					toolName: "plan_saved",
					args: {
						markdown:
							"# Plan\n\n1. Update `k8s/deployment.yaml`.\n2. Validate the published change.",
						summary: "Update the service deployment image",
						acceptanceCriteria: ["The manifest uses the new service image"],
					},
				};
			}

			if (names.has("changes_ready") && names.has("woodpecker_get_step_logs")) {
				factory.replaceWorkspaceText(
					"k8s/deployment.yaml",
					"        image: example/service:new\n",
					"        image: example/service:new\n        readinessProbe:\n          httpGet:\n            path: /ready\n            port: 8080\n",
				);
				records.push({ kind: "ci-repair", sessionId, prompt, toolNames });
				return {
					calls: [
						{
							toolName: "woodpecker_lookup_repository",
							args: { projectKey: "repo" },
						},
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
						{
							toolName: "changes_ready",
							args: { markdown: "Added the required readiness probe." },
						},
					],
				};
			}

			if (
				prompt.includes("Implement this requested change:") &&
				prompt.includes("Follow this plan:")
			) {
				factory.configureGitIdentity();
				factory.replaceWorkspaceText(
					"k8s/deployment.yaml",
					"        image: example/service:old",
					"        image: example/service:new",
				);
				records.push({ kind: "implementation", sessionId, prompt, toolNames });
				return {
					toolName: "markdown_result",
					args: {
						markdown: "## Implementation\n\nUpdated the service deployment image.",
					},
				};
			}

			if (names.has("markdown_result") || prompt.includes("commit message")) {
				records.push({ kind: "commit-message", sessionId, prompt, toolNames });
				return {
					toolName: "markdown_result",
					args: { markdown: "feat: update service deployment image" },
				};
			}

			throw new Error(`Unexpected fixture Pi turn with tools: ${toolNames.join(", ")}`);
		},
	});
	return factory;
}

const fixtureModelProviderExtension: LeitwerkExtensionModule = {
	manifest: { id: "remote-change-fixture-provider", version: "1.0.0" },
	modelProviders: defineModelProviders((rawConfig) => [
		{
			definition: defineModelProvider({
				id: "remote-change-fixture-provider",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("remote-change-fixture-provider"),
				server: builtinPiProvider("remote-change-fixture-provider"),
				models: () => [{ modelId: "fixture-model", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
	]),
};

type Poll = () => Promise<unknown>;

function createMockForgejoExtension(integration: MockForgejo, setPoll: (poll: Poll) => void) {
	return {
		manifest: { id: "forgejo", version: "1.0.0" },
		setupServer(api) {
			const provider = setupForgejoIntegration(
				api,
				integration,
				{ enabled: false, defaultLabels: [] },
				{ issueWatcherSource: forgejoIssueWatcherSource },
			);
			if (!provider) throw new Error("Forgejo fixture needs server setup deps");
			setPoll(() => provider.poll());
		},
	} satisfies LeitwerkExtensionModule;
}

function createMockWoodpeckerExtension(integration: MockWoodpecker, setPoll: (poll: Poll) => void) {
	return {
		manifest: { id: "woodpecker", version: "1.0.0" },
		setupServer(api) {
			// Each domain event is an explicit polling pass in this fixture. Advance
			// the provider clock so interval throttling does not turn a second exact-SHA
			// pipeline into a 30-second test sleep.
			let pollTime = Date.now();
			const provider = setupWoodpeckerIntegration(api, integration, {
				now: () => (pollTime += 60_000),
			});
			if (!provider) throw new Error("Woodpecker fixture needs server setup deps");
			setPoll(() => provider.poll());
		},
	} satisfies LeitwerkExtensionModule;
}

export function remoteState(process: ProcessInstance): Record<string, unknown> {
	const state = JSON.parse(process.stateJson ?? "{}") as Record<string, unknown>;
	const extensionState = state.extensionState as Record<string, unknown> | undefined;
	return (extensionState?.forgejoRepoChange as Record<string, unknown> | undefined) ?? {};
}

export interface RemoteRepoChangeFixture {
	harness: IntegrationHarness;
	forgejo: MockForgejo;
	woodpecker: MockWoodpecker;
	git: TemporaryGitRemote;
	piFactory: StubPiTreeHandleFactory;
	piTurns: readonly PiTurnRecord[];
	root: string;
	launchTicketlessChange(prompt: string): Promise<string>;
	exposeTriggeredIssue(): Promise<string>;
	approvePlan(instanceId: string): Promise<void>;
	approveImplementation(instanceId: string): Promise<void>;
	publishPipeline(input: PipelineFixture): Promise<void>;
	markPullRequestMerged(): Promise<void>;
	markPullRequestClosed(): Promise<void>;
	waitForTurn(instanceId: string, turnId: string): Promise<ProcessInstance>;
	waitForHeadChange(instanceId: string, previousSha: string): Promise<string>;
	waitForCompleted(instanceId: string): Promise<ProcessInstance>;
	waitForAborted(instanceId: string): Promise<ProcessInstance>;
	close(): Promise<void>;
}

async function action(harness: IntegrationHarness, instanceId: string, actionId: string) {
	const response = await fetch(
		`${harness.address}/api/processes/${encodeURIComponent(instanceId)}/actions/${encodeURIComponent(actionId)}`,
		{ method: "POST" },
	);
	if (response.status !== 200) {
		throw new Error(
			`Process action '${actionId}' failed with ${response.status}: ${await response.text()}`,
		);
	}
}

export async function createRemoteRepoChangeFixture(
	dockerPreflight: (timeoutMs: number) => Promise<void> = async () => {},
	options: { docker?: boolean; botLogin?: string } = {},
): Promise<RemoteRepoChangeFixture> {
	const root = await mkdtemp(path.join(tmpdir(), FIXTURE_PREFIX));
	let harness: IntegrationHarness | null = null;
	try {
		const temporaryGit = await TemporaryGitRemote.create(root);
		const forgejo = new MockForgejo(temporaryGit, options.botLogin);
		const woodpecker = new MockWoodpecker();
		const piTurns: PiTurnRecord[] = [];
		const piFactory = createPiFactory(piTurns);
		let forgejoPoll: Poll | null = null;
		let woodpeckerPoll: Poll | null = null;

		const extensionCatalog = await buildExtensionCatalogFromModules([
			codingExtension,
			gitSshExtension,
			createMockForgejoExtension(forgejo, (poll) => {
				forgejoPoll = poll;
			}),
			createMockWoodpeckerExtension(woodpecker, (poll) => {
				woodpeckerPoll = poll;
			}),
			createForgejoRepoChange({ docker: options.docker ?? true }).extension,
			fixtureModelProviderExtension,
		]);

		await mkdir(path.join(root, "storage", "trees"), { recursive: true });
		await mkdir(path.join(root, "storage", "workspaces"), { recursive: true });
		harness = await createIntegrationHarness({
			extensionCatalog,
			appOverrides: {
				// This fixture simulates worker tools; live Docker is covered by the opt-in runtime gate.
				localWorkerDockerPreflightImpl: dockerPreflight,
				localWorkerSpawnImpl: createInProcessWorkerSpawn({
					extensionCatalog,
					piFactory,
				}),
			},
			configOverride(config) {
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

		const requireProcess = (instanceId: string): ProcessInstance => {
			const process = harness?.ctx.deps.processes.getById(instanceId);
			if (!process) throw new Error(`Unknown process '${instanceId}' in fixture ${root}`);
			return process;
		};
		const waitForProcess = async (
			instanceId: string,
			predicate: (process: ProcessInstance) => boolean,
			description: string,
		): Promise<ProcessInstance> => {
			try {
				return await waitForValue(() => requireProcess(instanceId), predicate, 12_000);
			} catch (error) {
				const current = requireProcess(instanceId);
				const turns =
					harness?.ctx.deps.turnRecords.listByInstance(instanceId).map((turn) => ({
						turnId: turn.turnId,
						status: turn.status,
						errorSummary: turn.errorSummary,
					})) ?? [];
				throw new Error(
					`Timed out waiting for ${description} in fixture ${root}; current=${JSON.stringify({ selectedTurnId: current.selectedTurnId, lifecycleStatus: current.lifecycleStatus, remoteState: remoteState(current), turns, piTurns })}`,
					{ cause: error },
				);
			}
		};

		const fixture: RemoteRepoChangeFixture = {
			harness,
			forgejo,
			woodpecker,
			git: temporaryGit,
			piFactory,
			piTurns,
			root,
			async launchTicketlessChange(prompt) {
				if (!harness) throw new Error("Fixture harness is not running");
				const response = await postImmediateLaunch(
					harness.address,
					"forgejo_repo_change_process.ui_launcher",
					{
						launcherInput: {
							forgejoProfile: PROFILE,
							repository: `${OWNER}/${REPO}`,
							prompt,
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
				await fixture.waitForTurn(instanceId, "plan_decision");
				return instanceId;
			},
			async exposeTriggeredIssue() {
				forgejo.exposeTriggeredIssue();
				if (!forgejoPoll) throw new Error("Forgejo fixture provider was not initialized");
				const pollResult = await forgejoPoll();
				const pollErrors = (pollResult as { errors?: unknown }).errors;
				if (Array.isArray(pollErrors) && pollErrors.length > 0) {
					throw new Error(`Forgejo fixture poll failed: ${pollErrors.join(", ")}`);
				}
				const pollCreated = (pollResult as { created?: unknown }).created;
				if (!Array.isArray(pollCreated) || pollCreated.length === 0) {
					throw new Error(
						`Forgejo fixture poll did not create a process: ${JSON.stringify(pollResult)}`,
					);
				}
				const launched = await waitForValue(
					() =>
						harness?.ctx.deps.processes
							.listAll()
							.filter((process) => process.processId === PROCESS_ID) ?? [],
					(processes) => processes.length === 1,
					12_000,
				);
				const instanceId = launched[0]?.id;
				if (!instanceId)
					throw new Error("Forgejo poll did not launch the repository-change process");
				await fixture.waitForTurn(instanceId, "plan_decision");
				return instanceId;
			},
			async approvePlan(instanceId) {
				await action(harness as IntegrationHarness, instanceId, codingActionIds.approvePlan);
				await fixture.waitForTurn(instanceId, "implementation_decision");
			},
			async approveImplementation(instanceId) {
				await action(harness as IntegrationHarness, instanceId, codingActionIds.finalizeChange);
				await fixture.waitForTurn(instanceId, "deliver_change");
			},
			async publishPipeline(input) {
				woodpecker.publish(input);
				if (!woodpeckerPoll) throw new Error("Woodpecker fixture provider was not initialized");
				await woodpeckerPoll();
			},
			async markPullRequestMerged() {
				forgejo.markPullRequestMerged();
				if (!forgejoPoll) throw new Error("Forgejo fixture provider was not initialized");
				await forgejoPoll();
			},
			async markPullRequestClosed() {
				forgejo.markPullRequestClosed();
				if (!forgejoPoll) throw new Error("Forgejo fixture provider was not initialized");
				await forgejoPoll();
			},
			waitForTurn(instanceId, turnId) {
				return waitForProcess(
					instanceId,
					(process) => process.selectedTurnId === turnId && process.lifecycleStatus === "waiting",
					`${turnId}/waiting`,
				);
			},
			async waitForHeadChange(instanceId, previousSha) {
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
			waitForCompleted(instanceId) {
				return waitForProcess(
					instanceId,
					(process) => process.selectedTurnId === null && process.lifecycleStatus === "completed",
					"completed process",
				);
			},
			waitForAborted(instanceId) {
				return waitForProcess(
					instanceId,
					(process) => process.selectedTurnId === null && process.lifecycleStatus === "aborted",
					"aborted process",
				);
			},
			async close() {
				await harness?.ctx.app.close();
				const expectedPrefix = path.join(tmpdir(), FIXTURE_PREFIX);
				if (!root.startsWith(expectedPrefix)) {
					throw new Error(`Refusing to remove unvalidated fixture root '${root}'`);
				}
				await rm(root, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 100,
				});
			},
		};
		return fixture;
	} catch (error) {
		await harness?.ctx.app.close();
		if (root.startsWith(path.join(tmpdir(), FIXTURE_PREFIX))) {
			await rm(root, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		}
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

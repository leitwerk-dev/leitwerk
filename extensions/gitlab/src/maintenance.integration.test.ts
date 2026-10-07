import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { type Codec, defineProcess, emptyParamsCodec, humanTurn } from "@leitwerk-dev/process-sdk";
import { createPollingTestExtension } from "@leitwerk-dev/test-support";
import { createIntegrationHarness, waitForValue } from "@leitwerk-dev/test-support/integration";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { expect, it } from "vitest";
import { GitLabClient, type GitLabFeedback } from "./client.js";
import {
	type GitLabMaintenanceEvent,
	gitlabMaintenanceSource,
	registerGitLabMaintainedProcess,
} from "./maintenance.js";
import { LocalGitLabAdapter, setupGitLabIntegration } from "./testing.js";

type State = { cursor: number; batch: GitLabFeedback[] };
const stateCodec: Codec<State> = { parse: (value) => value as State, serialize: (value) => value };

async function fixture(onFinished: (fn: () => Promise<void>) => void) {
	const root = mkdtempSync(join(tmpdir(), "gitlab-maintained-"));
	const git = new LocalGit(root);
	const bare = git.seed({ owner: "team", name: "repo" }).bare;
	git.run(bare, ["branch", "feature", "main"]);
	const adapter = new LocalGitLabAdapter(root);
	const project = adapter.addProject("team/repo", bare);
	const mr = adapter.openMr(project, "feature");
	const notes: { id: number; body: string; author: { username: string }; created_at: string }[] =
		[];
	const feedbackReader = new GitLabClient(
		{ baseUrl: adapter.baseUrl, token: "test", ignoredCommentUsers: ["sonarqube"] },
		{
			fetch: async () => Response.json([{ id: "thread", notes }]),
		},
	);
	let labelReadFailure = false;
	let clock = Date.parse("2026-10-06T10:00:00Z");
	const source = gitlabMaintenanceSource<Record<string, never>, State>();
	const process = defineProcess<Record<string, never>, State>({
		id: "minimal_maintained",
		displayName: "Minimal maintained process",
		entry: "observe",
		paramsCodec: emptyParamsCodec,
		stateCodec,
		initialState: () => ({ cursor: 0, batch: [] }),
		turns: {
			observe: humanTurn({
				description: "Observe MR",
				actions: {
					stop: { label: "Stop", acceptanceState: "neutral", lifecycleStatus: "aborted" },
				},
				externalActions: {
					feedback: {
						id: "feedback",
						source,
						to: "review",
						effect: ({ event }) => ({ state: (event as GitLabMaintenanceEvent<State>).state }),
					},
				},
			}),
			review: humanTurn({
				description: "Review feedback",
				actions: {
					acknowledge: {
						label: "Acknowledge",
						acceptanceState: "accepted",
						to: "observe",
						effect: ({ ctx }) => ({
							state: {
								cursor: Math.max(ctx.state.cursor, ...ctx.state.batch.map((note) => note.id)),
								batch: [],
							},
						}),
					},
				},
			}),
		},
	});
	const provider = createPollingTestExtension(
		{ id: "gitlab", version: "1" },
		(api) => {
			const service = setupGitLabIntegration(
				api,
				{
					profiles: () => ["team"],
					client: () => ({
						...adapter.client(),
						listMergeRequestLabelEvents: async (...args) => {
							if (labelReadFailure) {
								labelReadFailure = false;
								throw new Error("GitLab label read unavailable");
							}
							return adapter.client().listMergeRequestLabelEvents(...args);
						},
						listMergeRequestFeedback: feedbackReader.listMergeRequestFeedback.bind(feedbackReader),
					}),
				},
				{ now: () => clock },
			);
			return service?.maintenance;
		},
		true,
	);
	const catalog = await buildExtensionCatalogFromModules([
		provider,
		{
			manifest: { id: "minimal", version: "1", requires: ["gitlab"] },
			setupCatalog(api) {
				api.registerProcess(process);
			},
			setupServer(api) {
				registerGitLabMaintainedProcess(api, {
					processId: process.id,
					paramsCodec: process.paramsCodec,
					stateCodec,
					idleTurnId: "observe",
					destinations: { feedback: "feedback", conflict: "feedback", ci: "feedback" },
					settings: (ctx) => ({ cursor: ctx.state.cursor, pollInterval: "1s" }),
					observe: (ctx, _binding, observation) =>
						ctx.state.batch.length || !observation.feedback?.length
							? { state: ctx.state }
							: { state: { ...ctx.state, batch: observation.feedback }, action: "feedback" },
				});
			},
		},
	]);
	const open = () =>
		createIntegrationHarness({
			listen: false,
			extensionCatalog: catalog,
			configOverride(config) {
				config.storage.sqlite_path = join(root, "state.sqlite");
				config.storage.tree_files_dir = join(root, "trees");
				config.storage.process_workspaces_dir = join(root, "workspaces");
				config.pi.agent_dir = join(root, "pi");
			},
		});
	let harness = await open();
	onFinished(async () => {
		await harness.close();
		rmSync(root, { recursive: true, force: true });
	});
	const instance = harness.ctx.deps.processes.create({
		processId: process.id,
		paramsJson: "{}",
		stateJson: JSON.stringify({ cursor: 0, batch: [] }),
	});
	harness.ctx.deps.projects.create({
		instanceId: instance.id,
		key: "repo",
		repoLocator: bare,
		baseBranch: "main",
		workBranch: "feature",
		metadata: {
			gitlab: { origin: adapter.baseUrl, profile: "team", projectId: project.id, iid: mr.iid },
		},
	});
	const started = await harness.ctx.deps.processEngine.startProcess(instance.id, "observe");
	if (!started.ok) throw new Error(JSON.stringify(started));
	await waitForValue(
		() => harness.ctx.deps.externalSourceService.listArmed(source.kind).length,
		Boolean,
		1000,
	);
	return {
		get harness() {
			return harness;
		},
		async restart() {
			await harness.close();
			harness = await open();
		},
		unavailableLabels() {
			labelReadFailure = true;
		},
		adapter,
		mr,
		notes,
		instance,
		provider,
		advance(ms: number) {
			clock += ms;
		},
		now: () => clock,
	};
}

it("a third process registers maintenance without a watcher and preserves the trailing feedback boundary", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished);
	expect((await f.provider.poll()).errors).toEqual([]);
	expect(f.mr.labels).toContain("leitwerk-active");
	const initialRecords = f.harness.ctx.deps.turnRecords.listByInstance(f.instance.id).length;
	f.notes.push({
		id: 1,
		body: "Quality gate",
		author: { username: "sonarqube" },
		created_at: new Date(f.now()).toISOString(),
	});
	f.advance(130_000);
	await f.provider.poll();
	expect(f.harness.ctx.deps.processes.getById(f.instance.id)?.selectedTurnId).toBe("observe");
	f.notes.push({
		id: 2,
		body: "Please adjust",
		author: { username: "reviewer" },
		created_at: new Date(f.now()).toISOString(),
	});
	f.advance(1000);
	f.adapter.loseNextReactionResponse = true;
	await f.provider.poll();
	f.advance(118_000);
	f.notes.push({
		id: 3,
		body: "Automated gate",
		author: { username: "SonarQube" },
		created_at: new Date(f.now()).toISOString(),
	});
	await f.provider.poll();
	expect(f.harness.ctx.deps.turnRecords.listByInstance(f.instance.id)).toHaveLength(initialRecords);
	f.notes.push({
		id: 4,
		body: "One more request",
		author: { username: "reviewer" },
		created_at: new Date(f.now()).toISOString(),
	});
	f.advance(2000);
	await f.provider.poll();
	expect(f.harness.ctx.deps.processes.getById(f.instance.id)?.selectedTurnId).toBe("observe");
	f.advance(119_000);
	f.adapter.loseNextReactionResponse = true;
	expect((await f.provider.poll()).errors).toEqual([]);
	await waitForValue(
		() => f.harness.ctx.deps.processes.getById(f.instance.id)?.selectedTurnId,
		(turn) => turn === "review",
		1000,
	);
	const state = JSON.parse(f.harness.ctx.deps.processes.getById(f.instance.id)?.stateJson ?? "{}");
	expect(state.batch.map((note: GitLabFeedback) => note.id)).toEqual([2, 4]);
	expect(Object.values(f.adapter.state.reactions ?? {}).flat()).toHaveLength(2);
	f.advance(30_000);
	await f.provider.poll();
	expect(Object.values(f.adapter.state.reactions ?? {}).flat()).toHaveLength(2);
});

it("merged MRs gain done while stopped MRs remain open without done", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished);
	await f.provider.poll();
	f.adapter.loseNextLabelResponse = true;
	f.adapter.merge(f.mr);
	f.advance(30_000);
	expect((await f.provider.poll()).errors).toEqual([]);
	expect(f.harness.ctx.deps.processes.getById(f.instance.id)?.lifecycleStatus).toBe("completed");
	expect(f.mr.labels).toContain("leitwerk-done");
	expect(f.mr.labels).not.toContain("leitwerk-active");
});

it("closed unmerged MRs abort without adding done", async ({ onTestFinished }) => {
	const f = await fixture(onTestFinished);
	await f.provider.poll();
	f.mr.state = "closed";
	f.adapter.save();
	f.advance(30_000);
	expect((await f.provider.poll()).errors).toEqual([]);
	expect(f.harness.ctx.deps.processes.getById(f.instance.id)?.lifecycleStatus).toBe("aborted");
	expect(f.mr.labels).not.toContain("leitwerk-done");
	expect(f.mr.labels).not.toContain("leitwerk-active");
});

it("adopts existing live bindings without changing cursors, selected turns or history", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished);
	f.harness.ctx.deps.processes.update(f.instance.id, {
		stateJson: JSON.stringify({ cursor: 41, batch: [] }),
	});
	const before = f.harness.ctx.deps.turnRecords.listByInstance(f.instance.id);
	await f.provider.poll();
	expect(f.mr.labels).toContain("leitwerk-active");
	expect(f.harness.ctx.deps.turnRecords.listByInstance(f.instance.id)).toEqual(before);
	await f.restart();
	f.advance(30_000);
	await f.provider.poll();
	expect(
		JSON.parse(f.harness.ctx.deps.processes.getById(f.instance.id)?.stateJson ?? "{}").cursor,
	).toBe(41);
	expect(f.harness.ctx.deps.processes.getById(f.instance.id)?.selectedTurnId).toBe("observe");
	expect(f.harness.ctx.deps.turnRecords.listByInstance(f.instance.id)).toEqual(before);
	expect(f.adapter.state.labelEvents?.[`${f.mr.project_id}:${f.mr.iid}`]).toHaveLength(1);
});

it("retries failed label reads and aborts the old activation on remove/re-add across restart", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished);
	await f.provider.poll();
	f.advance(30_000);
	f.unavailableLabels();
	expect((await f.provider.poll()).errors.join(" ")).toContain("label read unavailable");
	expect(f.harness.ctx.deps.processes.getById(f.instance.id)?.lifecycleStatus).toBe("waiting");
	await f.adapter
		.client()
		.updateMergeRequestLabels(f.mr.project_id, f.mr.iid, { remove_labels: "leitwerk-active" });
	await f.adapter
		.client()
		.updateMergeRequestLabels(f.mr.project_id, f.mr.iid, { add_labels: "leitwerk-active" });
	await f.restart();
	expect((await f.provider.poll()).errors).toEqual([]);
	expect(f.harness.ctx.deps.processes.getById(f.instance.id)?.lifecycleStatus).toBe("aborted");
	expect(f.mr.state).toBe("opened");
	expect(f.mr.labels).toContain("leitwerk-active");
	expect(f.mr.labels).not.toContain("leitwerk-done");
});

import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { type Codec, defineProcess, emptyParamsCodec, humanTurn } from "@leitwerk-dev/process-sdk";
import { createPollingTestExtension } from "@leitwerk-dev/test-support";
import {
	createPersistentIntegrationFixture,
	waitForValue,
} from "@leitwerk-dev/test-support/integration";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { expect, it, onTestFinished, vi } from "vitest";
import { GitLabClient, GitLabError, type GitLabFeedback } from "./client.js";
import {
	GITLAB_MAINTAINED_KIND,
	type GitLabMaintenanceEvent,
	gitlabMaintenanceSource,
	registerGitLabMaintainedProcess,
} from "./maintenance.js";
import { LocalGitLabAdapter, setupGitLabIntegration } from "./testing.js";

type State = { cursor: number; batch: GitLabFeedback[] };
const stateCodec: Codec<State> = { parse: (value) => value as State, serialize: (value) => value };

async function fixture(
	onFinished: (fn: () => Promise<void>) => void,
	retry?: { maxAttempts: number },
) {
	const persistent = createPersistentIntegrationFixture("gitlab-maintained-");
	onFinished(persistent.dispose);
	const { root } = persistent;
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
	const readFailures: { labels?: GitLabError; mr?: GitLabError; project?: GitLabError } = {};
	let reads = 0;
	let eligible = true;
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
							reads++;
							if (readFailures.labels) throw readFailures.labels;
							if (labelReadFailure) {
								labelReadFailure = false;
								throw new Error("GitLab label read unavailable");
							}
							return adapter.client().listMergeRequestLabelEvents(...args);
						},
						getMergeRequest: async (...args) => {
							reads++;
							if (readFailures.mr) throw readFailures.mr;
							return adapter.client().getMergeRequest(...args);
						},
						getProject: async (...args) => {
							reads++;
							if (readFailures.project) throw readFailures.project;
							return adapter.client().getProject(...args);
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
					retry,
					eligible: () => eligible,
					settings: (ctx) => ({ cursor: ctx.state.cursor, pollInterval: "1s" }),
					observe: (ctx, _binding, observation) =>
						ctx.state.batch.length || !observation.feedback?.length
							? { state: ctx.state }
							: { state: { ...ctx.state, batch: observation.feedback }, action: "feedback" },
				});
			},
		},
	]);
	const open = () => persistent.open({ listen: false, extensionCatalog: catalog });
	let harness = await open();
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
			await persistent.close();
			harness = await open();
		},
		setEligible(value: boolean) {
			eligible = value;
		},
		unavailableLabels() {
			labelReadFailure = true;
		},
		adapter,
		mr,
		notes,
		instance,
		provider,
		readFailures,
		reads: () => reads,
		advance(ms: number) {
			clock += ms;
		},
		now: () => clock,
	};
}

it("delegates eligible startup failures to the server budget without a process retry policy", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished);
	await f.provider.poll();
	const deps = f.harness.ctx.deps;
	const start = deps.turnStarts.create({
		instanceId: f.instance.id,
		turnId: "review",
		turnType: "automatic",
		proposedTurnRecordId: "pending_review",
		startKind: "selected_turn",
		state: {
			kind: "bootstrap_failed",
			start: { kind: "automatic" },
			failedWorkerLeaseId: null,
			code: "startup_timeout",
			safeSummary: "Timeout",
		},
	});
	deps.processes.update(f.instance.id, {
		selectedTurnId: "review",
		lifecycleStatus: "error",
		currentExecution: { kind: "worker_start", id: start.id },
	});
	const recover = vi.spyOn(deps.processEngine, "retryStartupAutomatically");
	const retryProcess = vi.spyOn(deps.processEngine, "retryProcess");
	onTestFinished(() => {
		recover.mockRestore();
		retryProcess.mockRestore();
	});
	f.setEligible(false);
	f.advance(1000);
	await f.provider.poll();
	expect(recover).not.toHaveBeenCalled();
	f.setEligible(true);
	f.advance(1000);
	expect((await f.provider.poll()).errors).toEqual([]);
	expect(recover).toHaveBeenCalledExactlyOnceWith(f.instance.id, start.id);
	const retained = deps.turnStarts.getById(start.id)?.state.automaticRetry;
	expect(retained).toMatchObject({ episodeStartRecordId: start.id, starts: 1 });
	expect(retained?.nextRetryAt).toEqual(expect.any(String));
	expect(deps.turnStarts.listByInstance(f.instance.id)).toHaveLength(1);
	expect(retryProcess).not.toHaveBeenCalled();

	const failed = deps.turnStarts.getById(start.id);
	if (!failed || !retained) throw new Error("Expected retained startup recovery budget");
	deps.turnStarts.compareAndSetState({
		id: start.id,
		expectedKind: "bootstrap_failed",
		state: { ...failed.state, automaticRetry: { ...retained, starts: 3 } },
	});
	await f.restart();
	f.advance(1000);
	expect((await f.provider.poll()).errors).toEqual([]);
	expect(f.harness.ctx.deps.turnStarts.listByInstance(f.instance.id)).toHaveLength(1);
	expect(f.harness.ctx.deps.turnStarts.getById(start.id)?.state.automaticRetry).toMatchObject({
		starts: 3,
		nextRetryAt: null,
	});
});

it("never retries accepted failed turns even with a legacy maintenance retry policy", async ({
	onTestFinished,
}) => {
	const f = await fixture(onTestFinished, { maxAttempts: 10 });
	await f.provider.poll();
	const deps = f.harness.ctx.deps;
	const start = deps.turnStarts.create({
		instanceId: f.instance.id,
		turnId: "review",
		turnType: "automatic",
		proposedTurnRecordId: "failed_review",
		startKind: "selected_turn",
		state: { kind: "starting", start: { kind: "automatic" } },
	});
	const lease = deps.leases.create({
		instanceId: f.instance.id,
		workerId: "old_worker",
		state: "exited",
		turnStartRecordId: start.id,
	});
	const turn = deps.turnRecords.create({
		id: start.proposedTurnRecordId,
		instanceId: f.instance.id,
		turnId: "review",
		turnType: "automatic",
		status: "failed",
		turnStartRecordId: start.id,
		acceptedWorkerLeaseId: lease.id,
	});
	deps.turnStarts.compareAndSetState({
		id: start.id,
		expectedKind: "starting",
		state: {
			kind: "accepted",
			start: { kind: "automatic" },
			turnRecordId: turn.id,
			acceptedWorkerLeaseId: lease.id,
		},
	});
	deps.processes.update(f.instance.id, {
		selectedTurnId: "review",
		lifecycleStatus: "error",
		currentExecution: { kind: "worker_start", id: start.id },
	});
	const retryProcess = vi.spyOn(deps.processEngine, "retryProcess");
	onTestFinished(() => retryProcess.mockRestore());
	const before = deps.turnRecords.listByInstance(f.instance.id);
	for (let n = 0; n < 3; n++) {
		f.advance(300_000);
		expect((await f.provider.poll()).errors).toEqual([]);
	}
	expect(retryProcess).not.toHaveBeenCalled();
	expect(deps.turnStarts.listByInstance(f.instance.id)).toHaveLength(1);
	expect(deps.turnRecords.listByInstance(f.instance.id)).toEqual(before);
	expect(deps.processes.getById(f.instance.id)?.lifecycleStatus).toBe("error");
});

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

it.each([
	false,
	true,
])("aborts a deleted MR durably without remote writes (already adopted: %s)", async (adopted) => {
	const f = await fixture(onTestFinished);
	if (adopted) await f.provider.poll();
	const turns = f.harness.ctx.deps.turnRecords.listByInstance(f.instance.id);
	f.adapter.state.mrs = [];
	f.adapter.save();
	const remote = structuredClone(f.adapter.state);
	f.advance(30_000);
	expect((await f.provider.poll()).errors).toEqual([]);
	expect(f.harness.ctx.deps.processes.getById(f.instance.id)).toMatchObject({
		lifecycleStatus: "aborted",
		selectedTurnId: null,
		currentExecution: null,
		metadata: {
			gitlabMaintenance: { repo: { status: "deleted", pendingFeedback: [] } },
			gitlabMaintenanceCompleted: true,
		},
	});
	expect(f.harness.ctx.deps.externalSourceService.listArmed(GITLAB_MAINTAINED_KIND)).toHaveLength(
		0,
	);
	const reads = f.reads();
	await f.restart();
	f.advance(30_000);
	expect((await f.provider.poll()).errors).toEqual([]);
	expect(f.reads()).toBe(reads);
	expect(f.adapter.state).toEqual(remote);
	expect(f.harness.ctx.deps.processes.getById(f.instance.id)?.lifecycleStatus).toBe("aborted");
	expect(f.harness.ctx.deps.turnRecords.listByInstance(f.instance.id)).toEqual(turns);
});

it.each([
	{ label: "label endpoint missing while MR exists", labels: 404 },
	{ label: "MR missing with inaccessible project", mr: 404, project: 404 },
	{ label: "MR missing with forbidden project", mr: 404, project: 403 },
	{ label: "MR missing while project read is unavailable", mr: 404, project: 503 },
	{ label: "temporary MR failure", mr: 503 },
	{ label: "unauthorized MR access", mr: 401 },
])("keeps maintenance active for $label", async (failure) => {
	const f = await fixture(onTestFinished);
	await f.provider.poll();
	for (const field of ["labels", "mr", "project"] as const) {
		const status = (failure as Partial<Record<typeof field, number>>)[field];
		if (status) f.readFailures[field] = new GitLabError(status, status >= 500);
	}
	f.advance(30_000);
	expect((await f.provider.poll()).errors).toHaveLength(1);
	expect(f.harness.ctx.deps.processes.getById(f.instance.id)).toMatchObject({
		lifecycleStatus: "waiting",
		metadata: {
			gitlabMaintenance: { repo: { status: "active", refreshError: expect.any(String) } },
		},
	});
	for (const field of ["labels", "mr", "project"] as const) delete f.readFailures[field];
	f.advance(30_000);
	expect((await f.provider.poll()).errors).toEqual([]);
	expect(f.harness.ctx.deps.processes.getById(f.instance.id)?.lifecycleStatus).toBe("waiting");
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

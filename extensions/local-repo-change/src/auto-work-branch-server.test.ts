import type { ProcessInstance, ProcessProject } from "@leitwerk-dev/domain";
import {
	createTestProcessInstance,
	createTestProcessProject,
} from "@leitwerk-dev/extension-runtime/testing";
import type {
	DeferredProcessActivationSnapshot,
	PreparedDeferredProcessActivation,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { createLocalRepoChangeAutoWorkBranchCoordinator } from "./auto-work-branch-server.js";

const BASE_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function legacyMetadata(workBranch: string) {
	return {
		localRepoChange: {
			autoWorkBranch: {
				reason: "title_updated",
				workBranch,
				baseBranch: "main",
				baseBranchSha: BASE_SHA,
				randomHex: "abc",
				prompt: "Fix login",
				title: "Fix login flow",
				branchSource: "title",
			},
		},
	};
}

function createHarness(
	input: {
		title?: string | null;
		paramsBranch?: string | null;
		projectBranch?: string | null;
		processMetadata?: Record<string, unknown> | null;
		handoffPlanMarkdown?: string;
		resolveBaseBranchSha?: () => string | Promise<string>;
	} = {},
) {
	let process: ProcessInstance = createTestProcessInstance({
		id: "agt_auto_branch",
		processId: "local_repo_change_process",
		selectedTurnId: null,
		lifecycleStatus: "discovered",
		title: "title" in input ? input.title : "Fix login flow",
		metadata: input.processMetadata ?? null,
		paramsJson: JSON.stringify({
			...(input.handoffPlanMarkdown ? {} : { launchKind: "requested_change" }),
			repoLocator: "/tmp/repo",
			baseBranch: "main",
			workBranch: input.paramsBranch ?? "",
			prompt: "Fix login",
			...(input.handoffPlanMarkdown ? { handoffPlanMarkdown: input.handoffPlanMarkdown } : {}),
		}),
	});
	let project: ProcessProject = createTestProcessProject({
		id: "prj_auto_branch",
		instanceId: process.id,
		key: "repo",
		repoLocator: "/tmp/repo",
		repoLocatorKind: "local_path",
		baseBranch: "main",
		workBranch: input.projectBranch ?? null,
	});
	const scheduledFallbacks: Array<{ callback: () => void; delayMs: number }> = [];
	const activationEvents: PreparedDeferredProcessActivation[] = [];

	const snapshot = (): DeferredProcessActivationSnapshot => ({
		instanceId: process.id,
		processId: process.processId,
		lifecycleStatus: process.lifecycleStatus,
		selectedTurnId: process.selectedTurnId,
		title: process.title,
		paramsJson: process.paramsJson,
		processMetadata: process.metadata,
		projectId: project.id,
		projectKey: project.key,
		repoLocator: project.repoLocator,
		baseBranch: project.baseBranch,
		workBranch: project.workBranch,
		projectMetadata: project.metadata,
	});
	const activateDeferredProcess = vi.fn(
		async (_instanceId: string, prepared: PreparedDeferredProcessActivation) => {
			activationEvents.push(prepared);
			process = {
				...process,
				paramsJson: prepared.paramsJson,
				selectedTurnId: prepared.selectedTurnId,
				lifecycleStatus: "active",
			};
			project = {
				...project,
				workBranch: prepared.workBranch,
				metadata: prepared.projectMetadata,
			};
			return {
				ok: true as const,
				process,
				data: { outcome: "activated" as const },
			};
		},
	);
	const parkDeferredProcessActivationFailure = vi.fn(async () => {
		process = { ...process, lifecycleStatus: "error" };
		return {
			ok: true as const,
			process,
			data: { outcome: "parked" as const },
		};
	});
	const commands = {
		getDeferredProcessActivationSnapshots: () => ({
			outcome: "ready" as const,
			snapshots: [snapshot()],
		}),
		activateDeferredProcess,
		parkDeferredProcessActivationFailure,
	};
	const coordinator = createLocalRepoChangeAutoWorkBranchCoordinator({
		commands,
		resolveBaseBranchSha: input.resolveBaseBranchSha ?? (() => BASE_SHA),
		createRandomHex: () => "abc",
		schedulePromptFallback(callback, delayMs) {
			scheduledFallbacks.push({ callback, delayMs });
			return { unref() {} };
		},
	});
	return {
		get process() {
			return process;
		},
		set process(next: ProcessInstance) {
			process = next;
		},
		get project() {
			return project;
		},
		commands,
		activationEvents,
		activateDeferredProcess,
		parkDeferredProcessActivationFailure,
		scheduledFallbacks,
		coordinator,
	};
}

describe("local repo change deferred activation coordinator", () => {
	it("prepares and submits a title-derived branch in one semantic activation", async () => {
		const h = createHarness();
		await h.coordinator.reconcile(h.process.id, "title_updated");

		expect(h.activateDeferredProcess).toHaveBeenCalledOnce();
		expect(h.activationEvents[0]).toMatchObject({
			workBranch: "fix-login-flow-abc-a1b2c3d4e5f6",
			selectedTurnId: "generate_plan",
			event: {
				eventType: "local_repo_change.auto_work_branch_selected",
				data: { branchSource: "title" },
			},
		});
		expect(h.project.metadata).toMatchObject(legacyMetadata("fix-login-flow-abc-a1b2c3d4e5f6"));
		expect(h.process.metadata).toBeNull();
		expect(JSON.parse(h.process.paramsJson ?? "{}")).toMatchObject({
			launchKind: "requested_change",
			workBranch: "fix-login-flow-abc-a1b2c3d4e5f6",
		});
	});

	it("waits 30 seconds for a title and then permits prompt fallback", async () => {
		const h = createHarness({ title: null });
		await h.coordinator.reconcile(h.process.id, "process_created");
		expect(h.scheduledFallbacks).toEqual([expect.objectContaining({ delayMs: 30_000 })]);
		expect(h.activateDeferredProcess).not.toHaveBeenCalled();

		await h.coordinator.reconcile(h.process.id, "prompt_fallback");
		expect(h.activationEvents[0]).toMatchObject({
			workBranch: "fix-login-abc-a1b2c3d4e5f6",
			event: { data: { branchSource: "prompt_fallback" } },
		});
	});

	it("does not activate an explicit work branch", async () => {
		const h = createHarness({
			paramsBranch: "feature/manual",
			projectBranch: "feature/manual",
		});
		await h.coordinator.reconcile(h.process.id, "process_created");
		expect(h.activateDeferredProcess).not.toHaveBeenCalled();
	});

	it("recovers a legacy partial assignment and chooses the handoff turn", async () => {
		const branch = "fix-login-abc-a1b2c3d4e5f6";
		const h = createHarness({
			paramsBranch: branch,
			projectBranch: null,
			processMetadata: legacyMetadata(branch),
			handoffPlanMarkdown: "# Existing plan",
		});
		await h.coordinator.reconcileAll();
		expect(h.activationEvents[0]).toMatchObject({
			workBranch: branch,
			selectedTurnId: "import_plan",
		});
		expect(JSON.parse(h.activationEvents[0]?.paramsJson ?? "{}")).toMatchObject({
			launchKind: "imported_plan",
			importedPlanMarkdown: "# Existing plan",
		});
		expect(h.project.metadata).toMatchObject(legacyMetadata(branch));
	});

	it("retries a stale semantic preparation with a fresh snapshot", async () => {
		const h = createHarness();
		h.activateDeferredProcess
			.mockResolvedValueOnce({
				ok: true,
				process: h.process,
				data: { outcome: "stale" },
			})
			.mockImplementationOnce(async (_id, prepared) => ({
				ok: true,
				process: h.process,
				data: { outcome: prepared.workBranch ? ("activated" as const) : ("stale" as const) },
			}));
		await h.coordinator.reconcile(h.process.id, "title_updated");
		expect(h.activateDeferredProcess).toHaveBeenCalledTimes(2);
	});

	it("stops when deferred activation is no longer applicable", async () => {
		const h = createHarness();
		h.activateDeferredProcess.mockResolvedValue({
			ok: true,
			process: h.process,
			data: { outcome: "not_applicable" },
		});
		await h.coordinator.reconcile(h.process.id, "title_updated");
		expect(h.activateDeferredProcess).toHaveBeenCalledOnce();
		expect(h.parkDeferredProcessActivationFailure).not.toHaveBeenCalled();
	});

	it("parks after exhausting stale preparation retries", async () => {
		const h = createHarness();
		h.activateDeferredProcess.mockResolvedValue({
			ok: true,
			process: h.process,
			data: { outcome: "stale" },
		});
		await h.coordinator.reconcile(h.process.id, "title_updated");
		expect(h.activateDeferredProcess).toHaveBeenCalledTimes(3);
		expect(h.parkDeferredProcessActivationFailure).toHaveBeenCalledOnce();
	});

	it("parks genuine Git preparation failures atomically through the engine", async () => {
		const h = createHarness({
			resolveBaseBranchSha: () => {
				throw new Error("base branch is unavailable");
			},
		});
		await h.coordinator.reconcile(h.process.id, "title_updated");
		expect(h.parkDeferredProcessActivationFailure).toHaveBeenCalledWith(
			h.process.id,
			expect.objectContaining({
				errorClass: "git_error",
				event: expect.objectContaining({
					eventType: "local_repo_change.auto_work_branch_failed",
					message: expect.stringContaining("base branch is unavailable"),
				}),
			}),
		);
	});

	it("coalesces a trigger arriving during Git preparation into a follow-up run", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let resolutions = 0;
		const h = createHarness({
			resolveBaseBranchSha: async () => {
				resolutions += 1;
				if (resolutions === 1) await blocked;
				return BASE_SHA;
			},
		});
		const first = h.coordinator.reconcile(h.process.id, "process_created");
		const second = h.coordinator.reconcile(h.process.id, "title_updated");
		release();
		await Promise.all([first, second]);
		expect(h.activateDeferredProcess).toHaveBeenCalledOnce();
		expect(resolutions).toBe(1);
	});
});

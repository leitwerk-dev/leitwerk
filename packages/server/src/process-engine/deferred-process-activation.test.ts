import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparedDeferredProcessActivation } from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { createProcessOperationCoordinator } from "../process-operation-coordinator.js";
import {
	createDefaultTestProcessGraphRegistry,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../test-helpers/process-fixtures.js";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import { createProcessEngine } from "./engine.js";
import type { ProcessEngineDeps } from "./types.js";

function setup(overrides: Partial<ProcessEngineDeps> = {}, base = createTestDeps()) {
	const deps: ProcessEngineDeps = {
		...base,
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => undefined,
		processGraphs: createDefaultTestProcessGraphRegistry(),
		...overrides,
	};
	const process = deps.processes.create({
		processId: "jira_issue_process",
		lifecycleStatus: "discovered",
		selectedTurnId: null,
		title: "Fix login",
		paramsJson: '{"workBranch":""}',
	});
	const project = deps.projects.create({
		instanceId: process.id,
		key: "repo",
		repoLocator: "/tmp/repo",
		baseBranch: "main",
	});
	const engine = createProcessEngine(deps);
	const snapshot = engine.getDeferredProcessActivationSnapshots({
		instanceId: process.id,
		projectKey: project.key,
	});
	if (snapshot.outcome !== "ready" || !snapshot.snapshots[0]) {
		throw new Error("Expected deferred activation snapshot");
	}
	const prepared: PreparedDeferredProcessActivation = {
		expected: snapshot.snapshots[0],
		workBranch: "fix-login-abc-a1b2c3d4e5f6",
		paramsJson: '{"workBranch":"fix-login-abc-a1b2c3d4e5f6"}',
		projectMetadata: {
			localRepoChange: { autoWorkBranch: { workBranch: "fix-login-abc-a1b2c3d4e5f6" } },
		},
		selectedTurnId: "generate_plan",
		event: {
			eventType: "local_repo_change.auto_work_branch_selected",
			level: "info",
			message: "Selected automatic work branch",
			data: { workBranch: "fix-login-abc-a1b2c3d4e5f6" },
		},
	};
	return { base, deps, process, project, prepared, engine };
}

describe("ProcessEngine deferred process activation", () => {
	it("atomically commits params, one project, provenance, event, and first-turn selection", async () => {
		const s = setup();
		const result = await s.engine.activateDeferredProcess(s.process.id, s.prepared);

		expect(result).toMatchObject({ ok: true, data: { outcome: "activated" } });
		expect(s.deps.processes.getById(s.process.id)).toMatchObject({
			paramsJson: s.prepared.paramsJson,
			selectedTurnId: "generate_plan",
		});
		expect(s.deps.projects.getById(s.project.id)).toMatchObject({
			workBranch: s.prepared.workBranch,
			metadata: s.prepared.projectMetadata,
		});
		expect(s.deps.events.listByInstance(s.process.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "local_repo_change.auto_work_branch_selected" }),
				expect.objectContaining({ eventType: "turn_selected" }),
			]),
		);
		expect(s.deps.turnStarts.listByInstance(s.process.id)).toHaveLength(1);
	});

	it("activates an explicitly selected alternate entry through the real process graph", async () => {
		const process = createFixtureProcess({
			id: "jira_issue_process",
			entry: "generate_plan",
			alternateEntries: ["import_plan"],
		});
		const s = setup({ processGraphs: createProcessGraphRegistry([process]) });
		s.prepared.selectedTurnId = "import_plan";

		const result = await s.engine.activateDeferredProcess(s.process.id, s.prepared);

		expect(result).toMatchObject({ ok: true, data: { outcome: "activated" } });
		expect(s.deps.processes.getById(s.process.id)).toMatchObject({
			paramsJson: s.prepared.paramsJson,
			selectedTurnId: "import_plan",
		});
		expect(s.deps.projects.getById(s.project.id)).toMatchObject({
			workBranch: s.prepared.workBranch,
			metadata: s.prepared.projectMetadata,
		});
	});

	it("treats exact replay as success without duplicate durable writes", async () => {
		const s = setup();
		await s.engine.activateDeferredProcess(s.process.id, s.prepared);
		const eventCount = s.deps.events.listByInstance(s.process.id).length;

		const replay = await s.engine.activateDeferredProcess(s.process.id, s.prepared);
		expect(replay).toMatchObject({ ok: true, data: { outcome: "already_activated" } });
		expect(s.deps.events.listByInstance(s.process.id)).toHaveLength(eventCount);
		expect(s.deps.turnStarts.listByInstance(s.process.id)).toHaveLength(1);
	});

	it.each([
		["title", "process", { title: "New title" }],
		["params", "process", { paramsJson: '{"prompt":"new"}' }],
		["repository locator", "project", { repoLocator: "/tmp/other" }],
		["base branch", "project", { baseBranch: "develop" }],
	] as const)("returns stale when %s changes", async (_label, target, patch) => {
		const s = setup();
		if (target === "process") s.deps.processes.update(s.process.id, patch);
		else s.deps.projects.update(s.project.id, patch);
		const result = await s.engine.activateDeferredProcess(s.process.id, s.prepared);
		expect(result).toMatchObject({ ok: true, data: { outcome: "stale" } });
		expect(s.deps.projects.getById(s.project.id)?.workBranch).toBeNull();
	});

	it("returns not-applicable rather than overwriting a different work branch", async () => {
		const s = setup();
		s.deps.projects.update(s.project.id, { workBranch: "feature/newer" });
		const result = await s.engine.activateDeferredProcess(s.process.id, s.prepared);
		expect(result).toMatchObject({ ok: true, data: { outcome: "not_applicable" } });
		expect(s.deps.projects.getById(s.project.id)?.workBranch).toBe("feature/newer");
	});

	it("reports missing snapshots and invalid selected turns semantically", async () => {
		const s = setup();
		expect(
			s.engine.getDeferredProcessActivationSnapshots({
				instanceId: "missing",
				projectKey: "repo",
			}),
		).toEqual({ outcome: "process_not_found" });
		const projectless = s.deps.processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "discovered",
		});
		expect(
			s.engine.getDeferredProcessActivationSnapshots({
				instanceId: projectless.id,
				projectKey: "repo",
			}),
		).toEqual({ outcome: "project_not_found" });

		const invalid = setup();
		invalid.prepared.selectedTurnId = "missing_turn";
		const result = await invalid.engine.activateDeferredProcess(
			invalid.process.id,
			invalid.prepared,
		);
		expect(result).toMatchObject({ ok: true, data: { outcome: "invalid_selected_turn" } });
	});

	it("returns not-applicable for incompatible lifecycle state", async () => {
		const s = setup();
		s.deps.processes.update(s.process.id, { lifecycleStatus: "aborted" });
		const result = await s.engine.activateDeferredProcess(s.process.id, s.prepared);
		expect(result).toMatchObject({ ok: true, data: { outcome: "not_applicable" } });
	});

	it("rolls back every durable write when the project write fails", async () => {
		const s = setup();
		const originalTransaction = s.deps.transaction;
		s.deps.transaction = (fn) =>
			originalTransaction((repos) =>
				fn({
					...repos,
					projects: {
						...repos.projects,
						update() {
							throw new Error("injected project failure");
						},
					},
				} as typeof repos),
			);
		const result = await s.engine.activateDeferredProcess(s.process.id, s.prepared);
		expect(result).toMatchObject({ ok: false, stage: "pre_commit", code: "record_failed" });
		expect(s.deps.processes.getById(s.process.id)).toMatchObject({
			paramsJson: s.process.paramsJson,
			selectedTurnId: null,
		});
		expect(s.deps.events.listByInstance(s.process.id)).toHaveLength(0);
		expect(s.deps.turnStarts.listByInstance(s.process.id)).toHaveLength(0);
	});

	it("preserves a committed activation when a post-commit hook fails", async () => {
		const afterRecord = vi.fn(async () => {
			throw new Error("reaction setup failed");
		});
		const s = setup({ afterRecord });
		const result = await s.engine.activateDeferredProcess(s.process.id, s.prepared);
		expect(result).toMatchObject({ ok: false, stage: "post_commit" });
		expect(s.deps.projects.getById(s.project.id)?.workBranch).toBe(s.prepared.workBranch);
		expect(s.deps.processes.getById(s.process.id)?.selectedTurnId).toBe("generate_plan");
	});

	it("parks preparation failure and its explanatory event in one commit", async () => {
		const s = setup();
		const result = await s.engine.parkDeferredProcessActivationFailure(s.process.id, {
			expected: s.prepared.expected,
			errorClass: "git_error",
			reason: "base branch unavailable",
			event: {
				eventType: "local_repo_change.auto_work_branch_failed",
				level: "warn",
				message: "base branch unavailable",
				data: { error: "base branch unavailable" },
			},
		});
		expect(result.ok).toBe(true);
		expect(s.deps.processes.getById(s.process.id)?.lifecycleStatus).toBe("error");
		expect(s.deps.events.listByInstance(s.process.id)).toEqual([
			expect.objectContaining({ eventType: "local_repo_change.auto_work_branch_failed" }),
		]);
	});

	it("persists an atomic activation in file-backed SQLite", async () => {
		const root = mkdtempSync(join(tmpdir(), "leitwerk-deferred-activation-"));
		const sqlitePath = join(root, "leitwerk.sqlite");
		try {
			const s = setup({}, createTestDeps({ sqlitePath }));
			const result = await s.engine.activateDeferredProcess(s.process.id, s.prepared);
			expect(result.ok).toBe(true);

			const reopened = createTestDeps({ sqlitePath });
			expect(reopened.processes.getById(s.process.id)).toMatchObject({
				paramsJson: s.prepared.paramsJson,
				selectedTurnId: s.prepared.selectedTurnId,
			});
			expect(reopened.projects.getById(s.project.id)).toMatchObject({
				workBranch: s.prepared.workBranch,
				metadata: s.prepared.projectMetadata,
			});
			expect(reopened.events.listByInstance(s.process.id)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						eventType: "local_repo_change.auto_work_branch_selected",
					}),
				]),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

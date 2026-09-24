import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { serializeFutureActionPayload } from "@leitwerk-dev/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDatabase } from "./db/database.js";
import { createModelStatusCache } from "./model-providers/model-status-cache.js";
import {
	createModelProviderRegistry,
	defaultModelProviderCredentialStatus,
} from "./model-providers/registry.js";
import { listVisibleActionsForProcess } from "./process-action-presenter.js";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { buildProcessLauncherRegistry } from "./process-launcher-registry.js";
import {
	createFileBackedProcessSessionSnapshotStore,
	ProcessSessionReader,
	type ProcessSessionSource,
} from "./process-session-store.js";
import { ProcessUiSnapshotAssembler } from "./process-ui-snapshot-presenter.js";
import { ProcessDiagnosticsAssembler } from "./routes/process-diagnostics-assembler.js";
import { ProcessPrimaryPathAssembler } from "./routes/process-primary-path-assembler.js";
import { createDefaultTestProcessGraphRegistry } from "./test-helpers/process-fixtures.js";
import { createStructuralStateJson } from "./test-helpers/structural-process-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

async function createReadFixture() {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-process-detail-reads-"));
	const testDeps = createTestDeps();
	const processGraphs = createDefaultTestProcessGraphRegistry();
	const catalog = { processes: processGraphs };
	const source = createFileBackedProcessSessionSnapshotStore(root);
	const deps = {
		...testDeps,
		processGraphs,
		processActionRegistry: buildProcessActionRegistry(catalog),
		launcherService: buildProcessLauncherRegistry(catalog),
		modelStatusCache: createModelStatusCache({
			registry: createModelProviderRegistry({
				sets: [],
				piContributions: [],
				extensionConfig: {},
				modelProfiles: [],
				titleModelProfileId: null,
			}),
			modelProfiles: [],
			credentialStatus: defaultModelProviderCredentialStatus,
		}),
		sessionReader: new ProcessSessionReader(source),
	};
	return { root, db: testDeps.db, deps, source };
}

let fixture: Awaited<ReturnType<typeof createReadFixture>>;
beforeEach(async () => {
	fixture = await createReadFixture();
});
afterEach(async () => {
	vi.restoreAllMocks();
	closeDatabase(fixture.db);
	await rm(fixture.root, { recursive: true, force: true });
});

function pauseSessionRead(source: ProcessSessionSource) {
	const entered = Promise.withResolvers<void>();
	const resumed = Promise.withResolvers<void>();
	const reader = new ProcessSessionReader({
		async readSnapshotHandle(instanceId) {
			entered.resolve();
			await resumed.promise;
			return source.readSnapshotHandle(instanceId);
		},
	});
	return { reader, entered: entered.promise, resume: () => resumed.resolve() };
}

it("captures diagnostics before a process mutation during session loading", async () => {
	const { deps, source } = fixture;
	const process = deps.processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
		stateJson: createStructuralStateJson(),
	});
	const turn = deps.turnRecords.create({
		instanceId: process.id,
		turnId: "generate_plan",
		status: "running",
	});
	const leaseId = turn.acceptedWorkerLeaseId;
	if (!leaseId) throw new Error("Expected an accepted worker lease");
	const paused = pauseSessionRead(source);
	const pending = new ProcessDiagnosticsAssembler({
		...deps,
		sessionReader: paused.reader,
	}).assembleDetail(process.id);
	await paused.entered;
	try {
		deps.transaction((repos) => {
			repos.processes.update(process.id, { lifecycleStatus: "error" });
			repos.turnRecords.update(turn.id, {
				status: "failed",
				errorClass: "infrastructure",
				errorSummary: "Worker stopped during session loading",
				endedAt: new Date().toISOString(),
			});
			repos.leases.update(leaseId, { state: "failed" });
			repos.events.create({ instanceId: process.id, eventType: "worker_failed", data: {} });
		});
	} finally {
		paused.resume();
	}
	const detail = await pending;
	expect(detail?.process.lifecycleStatus).toBe("active");
	expect(detail?.turnRecords).toEqual([
		expect.objectContaining({ id: turn.id, status: "running" }),
	]);
	expect(detail?.workerLease?.state).toBe("busy");
	expect(detail?.events).toEqual([]);
	expect(deps.processes.getById(process.id)?.lifecycleStatus).toBe("error");
	expect(deps.turnRecords.getById(turn.id)?.status).toBe("failed");
});

it("captures primary-path state through its seven dependencies before session loading", async () => {
	const { deps, source } = fixture;
	const process = deps.processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
		stateJson: createStructuralStateJson(),
	});
	const turn = deps.turnRecords.create({
		instanceId: process.id,
		turnId: "generate_plan",
		status: "running",
	});
	const leaseId = turn.acceptedWorkerLeaseId;
	if (!leaseId) throw new Error("Expected an accepted worker lease");
	const paused = pauseSessionRead(source);
	const assembler = new ProcessPrimaryPathAssembler({
		processes: deps.processes,
		turnRecords: deps.turnRecords,
		turnStarts: deps.turnStarts,
		events: deps.events,
		leases: deps.leases,
		turnAnnotations: deps.turnAnnotations,
		sessionReader: paused.reader,
	});
	expect(await assembler.assemble("missing-process")).toBeNull();
	const pending = assembler.assemble(process.id);
	await paused.entered;
	try {
		deps.transaction((repos) => {
			repos.processes.update(process.id, { lifecycleStatus: "error" });
			repos.turnRecords.update(turn.id, { status: "failed", endedAt: new Date().toISOString() });
			repos.leases.update(leaseId, { state: "failed" });
		});
	} finally {
		paused.resume();
	}
	expect((await pending)?.turnState).toMatchObject({
		currentTurnRecordId: turn.id,
		workerState: "busy",
		isStreaming: true,
		activeTurn: { turnRecordId: turn.id },
	});
	expect((await assembler.assemble(process.id))?.turnState).toMatchObject({
		workerState: "failed",
		isStreaming: false,
		activeTurn: null,
	});
});

it("resolves visible actions once when presenting the action list", () => {
	const { deps } = fixture;
	const process = deps.processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "plan_review",
		lifecycleStatus: "waiting",
		stateJson: createStructuralStateJson(),
	});
	const resolve = vi.spyOn(deps.processActionRegistry, "listVisibleActions");
	const actions = listVisibleActionsForProcess(deps, process);
	expect(actions.length).toBeGreaterThan(0);
	expect(resolve).toHaveBeenCalledTimes(1);
	expect(actions.find((action) => action.id === "plan_approved")).toMatchObject({
		preview: { kind: "turn" },
		supportsScheduling: false,
	});
});

it("captures action availability before scheduling changes during session loading", async () => {
	const { deps, source } = fixture;
	const process = deps.processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "plan_review",
		lifecycleStatus: "waiting",
		stateJson: createStructuralStateJson(),
	});
	const assembler = new ProcessDiagnosticsAssembler(deps);
	const before = await assembler.assembleDetail(process.id);
	expect(before?.actions.length).toBeGreaterThan(0);
	const paused = pauseSessionRead(source);
	const pending = new ProcessDiagnosticsAssembler({
		...deps,
		sessionReader: paused.reader,
	}).assembleDetail(process.id);
	await paused.entered;
	try {
		deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "plan_approved",
			payloadJson: serializeFutureActionPayload({
				input: {},
				nextTurnModelProfileId: null,
				actionLabel: "Approve plan",
			}),
			nextRunAt: "2099-01-01T00:00:00Z",
		});
	} finally {
		paused.resume();
	}
	const captured = await pending;
	expect(captured?.actions).toEqual(before?.actions);
	expect(captured?.scheduledAction).toBeNull();
	const after = await assembler.assembleDetail(process.id);
	expect(after?.actions).toEqual([]);
	expect(after?.scheduledAction?.actionId).toBe("plan_approved");
	expect(after?.scheduledAction?.action).toMatchObject({
		id: "plan_approved",
		label: "Approve plan",
		preview: before?.actions.find((action) => action.id === "plan_approved")?.preview,
		supportsScheduling: true,
	});
});

it("keeps current-turn page reads and bytes bounded with cold and warm readers; expansion returns every recorded event", async () => {
	const { deps, db, source } = fixture;
	const process = deps.processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "implement",
		lifecycleStatus: "active",
		stateJson: createStructuralStateJson(),
	});
	const turn = deps.turnRecords.create({
		id: "trn_bounded_history",
		instanceId: process.id,
		turnId: "implement",
		status: "running",
		startedAt: "2026-09-09T00:00:00Z",
	});
	const events = deps.events;
	const append = (text: string) =>
		events.create({
			instanceId: process.id,
			eventType: "pi.stream.delta",
			data: {
				turnRecordId: turn.id,
				streamType: "thinking",
				text,
				timestamp: "2026-09-09T00:00:00Z",
			},
		});
	append("initial reasoning");
	const measure = async () => {
		const coldReader = new ProcessSessionReader(source);
		const readerSpy = vi.spyOn(coldReader, "readSessionTree");
		const forbidden = [
			vi.spyOn(events, "listByTurnRecord"),
			vi.spyOn(events, "listByInstanceSince"),
			vi.spyOn(events, "listByInstanceTurnRecordEventTypes"),
		];
		const summarySpy = vi.spyOn(deps.turnSummaries, "listByInstance");
		const eventRowsSpy = vi.spyOn(events, "listByInstanceEventTypes");
		const progressSpy = vi.spyOn(events, "latestByTurnRecordEventType");
		const preparedReadSpy = vi.spyOn(db.$client, "prepare");
		const assembler = new ProcessUiSnapshotAssembler({
			...deps,
			sessionReader: coldReader,
		});
		const snapshots = [await assembler.assemble(process.id), await assembler.assemble(process.id)];
		const eventQueries = preparedReadSpy.mock.results.flatMap((result) =>
			result.type === "return" && result.value.sourceSQL.includes('from "process_events"')
				? [result.value.expandedSQL]
				: [],
		);
		preparedReadSpy.mockRestore();
		expect(eventQueries.length).toBeGreaterThan(0);
		for (const query of eventQueries) {
			const plan = db.$client.prepare(`EXPLAIN QUERY PLAN ${query}`).all();
			const expectedIndex = query.includes('"turn_record_id" =')
				? "idx_process_events_turn_type_sequence"
				: query.includes('"event_type" =')
					? "idx_process_events_instance_type_sequence"
					: "idx_process_events_instance_sequence";
			expect(plan).toEqual([
				expect.objectContaining({ detail: expect.stringContaining(expectedIndex) }),
			]);
		}
		expect(readerSpy).not.toHaveBeenCalled();
		for (const spy of forbidden) {
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		}
		expect(summarySpy).toHaveBeenCalledTimes(2);
		expect(summarySpy.mock.results.map((result) => Object.keys(result.value))).toEqual([
			[turn.id],
			[turn.id],
		]);
		expect(eventRowsSpy.mock.results.map((result) => result.value.length)).toEqual([0, 0]);
		expect(progressSpy.mock.results.map((result) => result.value)).toEqual([null, null]);
		eventRowsSpy.mockRestore();
		progressSpy.mockRestore();
		summarySpy.mockRestore();
		const snapshot = snapshots[0];
		if (!snapshot) throw new Error("Expected process snapshot");
		return snapshot;
	};
	const short = await measure();
	const chunk = "long paragraph of recorded reasoning ".repeat(40);
	for (let i = 0; i < 2500; i++) append(chunk);
	events.create({
		instanceId: process.id,
		eventType: "pi.tool.call",
		data: {
			turnRecordId: turn.id,
			toolCallId: "read",
			toolName: "read",
			arguments: { path: "README.md" },
		},
	});
	events.create({
		instanceId: process.id,
		eventType: "pi.tool.result",
		data: {
			turnRecordId: turn.id,
			toolCallId: "read",
			toolName: "read",
			result: "complete tool result",
		},
	});
	const last = append("final reasoning");
	const long = await measure();
	events.create({
		instanceId: process.id,
		eventType: "pi.stream.delta",
		data: { turnRecordId: "another-turn", streamType: "thinking", text: "WRONG TURN" },
	});
	expect(long.primaryPath.turnState.activeTurn?.assistant.thinking.length).toBeLessThanOrEqual(
		1024,
	);
	expect(long.primaryPath.turnState.activeTurn?.assistant.thinking).toContain("final reasoning");
	expect(JSON.stringify(long).length - JSON.stringify(short).length).toBeLessThan(1800);
	expect(long.primaryPath.turnState.activeTurn).not.toHaveProperty("traceItems");
	expect(long.primaryPath.turnState.activeTurn).not.toHaveProperty("toolCalls");
	const detail = await new ProcessUiSnapshotAssembler(deps).assembleReasoningDetail({
		instanceId: process.id,
		turnRecordId: turn.id,
	});
	expect(detail?.state).toBe("live");
	expect(detail?.throughEventSequence).toBeGreaterThanOrEqual(last.eventSequence ?? 0);
	expect(detail?.reasoning.assistant.thinking).toBe(
		`initial reasoning${chunk.repeat(2500)}final reasoning`,
	);
	expect(detail?.reasoning.toolCalls[0]).toMatchObject({
		arguments: { path: "README.md" },
		resultText: "complete tool result",
		status: "completed",
	});
	deps.turnRecords.update(turn.id, {
		status: "failed",
		endedAt: "2026-09-09T00:01:00Z",
		errorSummary: "Worker exited before uploading its session snapshot",
	});
	const finished = await new ProcessUiSnapshotAssembler(deps).assembleReasoningDetail({
		instanceId: process.id,
		turnRecordId: turn.id,
	});
	expect(finished?.state).toBe("committed");
	expect(finished?.reasoning).toEqual(detail?.reasoning);
	const failedSnapshot = await new ProcessUiSnapshotAssembler(deps).assemble(process.id);
	expect(failedSnapshot?.timeline.tracePreviewsByTurnRecordId[turn.id]).toMatchObject({
		hasReasoningDetails: true,
		toolCallCount: 1,
		thinkingPreview: long.primaryPath.turnState.activeTurn?.assistant.thinking,
	});
});

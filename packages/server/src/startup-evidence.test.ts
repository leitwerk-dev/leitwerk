import type {
	LaunchRun,
	ProcessInstance,
	ProcessTurnRecord,
	TurnStartRecord,
	WorkerLease,
} from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { initialLaunchSteps } from "./launch-pipeline.js";
import {
	buildStartupEvidence,
	presentProcessStartupSummary,
	projectLaunchRunStartup,
} from "./startup-evidence.js";

const process = (currentStartId = "tsr_1"): ProcessInstance =>
	({
		id: "agt_1",
		processId: "demo",
		currentExecution: { kind: "worker_start", id: currentStartId },
		lifecycleStatus: "active",
		title: null,
	}) as ProcessInstance;

const start = (
	state: TurnStartRecord["state"] = { kind: "starting", start: {} as never },
	overrides: Partial<TurnStartRecord> = {},
): TurnStartRecord =>
	({
		id: "tsr_1",
		instanceId: "agt_1",
		state,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}) as TurnStartRecord;

const lease = (overrides: Partial<WorkerLease> = {}): WorkerLease =>
	({
		id: "wls_1",
		instanceId: "agt_1",
		workerId: "wrk_1",
		turnStartRecordId: "tsr_1",
		state: "starting",
		startedAt: "2026-01-01T00:00:01.000Z",
		connectedAt: null,
		workspacePreparationStartedAt: null,
		readyAt: null,
		bootstrapReceipt: null,
		exitedAt: null,
		...overrides,
	}) as WorkerLease;

const run = (): LaunchRun =>
	({
		id: "lnr_1",
		launcherId: "demo.ui",
		origin: "ui",
		instanceId: "agt_1",
		status: "starting",
		steps: initialLaunchSteps().map((step) =>
			["validate_request", "resolve_models_skills", "create_process"].includes(step.id)
				? { ...step, status: "completed" as const }
				: step,
		),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		completedAt: null,
		revision: 0,
	}) as LaunchRun;

function evidence(
	input: { leases?: WorkerLease[]; starts?: TurnStartRecord[]; records?: ProcessTurnRecord[] } = {},
) {
	return buildStartupEvidence({
		process: process(),
		turnStarts: input.starts ?? [start()],
		leases: input.leases ?? [],
		turnRecords: input.records ?? [],
	});
}

describe("startup evidence", () => {
	it("retains observed phase intervals instead of treating connection as an instant step", () => {
		const result = evidence({
			leases: [
				lease({
					connectedAt: "2026-01-01T00:00:08.000Z",
					readyAt: "2026-01-01T00:00:09.000Z",
				}),
			],
		});
		expect(result.currentAttempt?.steps[1]).toMatchObject({
			label: "Start worker",
			startedAt: "2026-01-01T00:00:01.000Z",
			endedAt: "2026-01-01T00:00:08.000Z",
		});
		const launch = projectLaunchRunStartup(run(), result, { status: "skipped" });
		expect(launch.steps.find((step) => step.id === "connect_worker")).toMatchObject({
			startedAt: "2026-01-01T00:00:01.000Z",
			completedAt: "2026-01-01T00:00:08.000Z",
		});
	});

	it("does not invent a connection duration from a legacy readiness receipt", () => {
		const result = evidence({
			leases: [
				lease({
					bootstrapReceipt: { readyAt: "2026-01-01T00:00:09.000Z" } as never,
				}),
			],
		});
		expect(result.currentAttempt?.steps[1].endedAt).toBeNull();
		expect(result.currentAttempt?.steps[2].startedAt).toBeNull();
	});

	it("ends a failed phase at the durable failure time", () => {
		const result = evidence({
			starts: [
				start(
					{
						kind: "bootstrap_failed",
						failedWorkerLeaseId: "wls_1",
						safeSummary: "Worker did not connect",
					} as never,
					{ updatedAt: "2026-01-01T00:00:12.000Z" },
				),
			],
			leases: [lease()],
		});
		expect(result.currentAttempt?.steps[1]).toMatchObject({
			status: "failed",
			endedAt: "2026-01-01T00:00:12.000Z",
		});
	});

	it.each([
		["no lease", [], ["in_progress", "pending", "pending", "pending"]],
		[
			"spawning worker",
			[lease({ state: "spawning" })],
			["completed", "in_progress", "pending", "pending"],
		],
		[
			"connected worker",
			[lease({ connectedAt: "2026-01-01T00:00:02.000Z" })],
			["completed", "completed", "in_progress", "pending"],
		],
		[
			"workspace preparation",
			[
				lease({
					connectedAt: "2026-01-01T00:00:02.000Z",
					workspacePreparationStartedAt: "2026-01-01T00:00:03.000Z",
				}),
			],
			["completed", "completed", "in_progress", "pending"],
		],
		[
			"ready worker",
			[lease({ connectedAt: "2026-01-01T00:00:02.000Z", readyAt: "2026-01-01T00:00:04.000Z" })],
			["completed", "completed", "completed", "in_progress"],
		],
	] as const)("projects %s", (_name, leases, statuses) => {
		expect(
			evidence({ leases: [...leases] }).currentAttempt?.steps.map((step) => step.status),
		).toEqual(statuses);
	});

	it("completes an accepted first turn from correlated durable evidence", () => {
		const accepted = start({
			kind: "accepted",
			start: {} as never,
			turnRecordId: "trn_1",
			acceptedWorkerLeaseId: "wls_1",
		});
		const result = evidence({
			starts: [accepted],
			leases: [
				lease({
					connectedAt: "2026-01-01T00:00:02.000Z",
					readyAt: "2026-01-01T00:00:04.000Z",
				}),
			],
			records: [
				{
					id: "trn_1",
					turnStartRecordId: "tsr_1",
					acceptedWorkerLeaseId: "wls_1",
					startedAt: "2026-01-01T00:00:05.000Z",
				} as ProcessTurnRecord,
			],
		});
		expect(result.authoritativeAttemptId).toBe("tsr_1");
		expect(result.currentAttempt?.steps.at(-1)?.status).toBe("completed");
	});

	it("retains successful startup when a replacement worker reuses the accepted start", () => {
		const accepted = start({
			kind: "accepted",
			start: {} as never,
			turnRecordId: "trn_1",
			acceptedWorkerLeaseId: "wls_1",
		});
		const originalLease = lease({
			connectedAt: "2026-01-01T00:00:02.000Z",
			readyAt: "2026-01-01T00:00:04.000Z",
			exitedAt: "2026-01-01T00:00:06.000Z",
		});
		const records = [
			{
				id: "trn_1",
				turnStartRecordId: "tsr_1",
				acceptedWorkerLeaseId: "wls_1",
				startedAt: "2026-01-01T00:00:05.000Z",
			} as ProcessTurnRecord,
		];
		const before = evidence({ starts: [accepted], leases: [originalLease], records });
		const after = evidence({
			starts: [accepted],
			leases: [
				originalLease,
				lease({
					id: "wls_2",
					workerId: "wrk_2",
					startedAt: "2026-01-01T00:00:07.000Z",
					connectedAt: "2026-01-01T00:00:08.000Z",
					readyAt: "2026-01-01T00:00:09.000Z",
				}),
			],
			records,
		});

		expect(after).toEqual(before);
		expect(after.currentAttempt).toMatchObject({
			status: "succeeded",
			workerLeaseId: "wls_1",
		});
		const completed = projectLaunchRunStartup(run(), before, { status: "skipped" });
		expect(completed.status).toBe("completed");
		expect(projectLaunchRunStartup(completed, after, { status: "skipped" })).toEqual(completed);
	});

	it("marks an older unaccepted attempt as superseded", () => {
		const newer = start(undefined, {
			id: "tsr_2",
			createdAt: "2026-01-01T00:00:01.000Z",
		});
		const result = buildStartupEvidence({
			process: process("tsr_2"),
			turnStarts: [start(), newer],
			leases: [],
			turnRecords: [],
		});
		expect(result.attempts.map((attempt) => attempt.status)).toEqual(["superseded", "starting"]);
	});

	it("retains a recovered failure beside a successful retry", () => {
		const failed = start({ kind: "preparation_failed", safeSummary: "Choose a model" } as never);
		const accepted = start(
			{
				kind: "accepted",
				start: {} as never,
				turnRecordId: "trn_2",
				acceptedWorkerLeaseId: "wls_2",
			},
			{ id: "tsr_2", createdAt: "2026-01-01T00:00:01.000Z" },
		);
		const result = buildStartupEvidence({
			process: process("tsr_2"),
			turnStarts: [failed, accepted],
			leases: [
				lease({
					id: "wls_2",
					turnStartRecordId: "tsr_2",
					connectedAt: "2026-01-01T00:00:03.000Z",
					readyAt: "2026-01-01T00:00:04.000Z",
				}),
			],
			turnRecords: [
				{
					id: "trn_2",
					turnStartRecordId: "tsr_2",
					acceptedWorkerLeaseId: "wls_2",
					startedAt: "2026-01-01T00:00:05.000Z",
				} as ProcessTurnRecord,
			],
		});
		expect(result.attempts.map((attempt) => attempt.status)).toEqual(["recovered", "succeeded"]);
		expect(result.attempts[0]?.recoveredByStartRecordId).toBe("tsr_2");
	});

	it("rejects a stale or mismatched accepted turn record", () => {
		const accepted = start({
			kind: "accepted",
			start: {} as never,
			turnRecordId: "trn_1",
			acceptedWorkerLeaseId: "wls_1",
		});
		const readyLease = lease({
			connectedAt: "2026-01-01T00:00:02.000Z",
			readyAt: "2026-01-01T00:00:04.000Z",
		});
		const result = buildStartupEvidence({
			process: process(),
			turnStarts: [accepted],
			leases: [readyLease],
			turnRecords: [
				{
					id: "trn_1",
					turnStartRecordId: "stale",
					acceptedWorkerLeaseId: "wls_1",
					startedAt: "2026-01-01T00:00:05.000Z",
				} as never,
			],
		});
		expect(result.currentAttempt?.steps.at(-1)?.status).toBe("in_progress");
		expect(presentProcessStartupSummary(result).authoritativeAttemptId).toBeNull();
	});

	it.each([
		"preparation_failed",
		"bootstrap_failed",
	] as const)("projects %s at its authoritative failed step", (kind) => {
		const failed = start({ kind, safeSummary: "Safe startup failure" } as TurnStartRecord["state"]);
		const projected = projectLaunchRunStartup(run(), evidence({ starts: [failed] }), {
			status: "skipped",
		});
		expect(projected).toMatchObject({ status: "failed" });
		expect(projected.steps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: "failed", safeSummary: "Safe startup failure" }),
			]),
		);
	});

	it("repairs startup steps that are ahead of durable evidence", () => {
		const stale = run();
		stale.steps = stale.steps.map((step) =>
			["connect_worker", "prepare_workspace", "start_first_turn"].includes(step.id)
				? { ...step, status: "completed" as const }
				: step,
		);

		const projected = projectLaunchRunStartup(stale, evidence(), { status: "pending" });

		expect(
			projected.steps
				.filter((step) =>
					["start_worker", "connect_worker", "prepare_workspace", "start_first_turn"].includes(
						step.id,
					),
				)
				.map((step) => step.status),
		).toEqual(["in_progress", "pending", "pending", "pending"]);
	});

	it.each([
		["pending", "in_progress"],
		["completed", "completed"],
		["failed", "failed"],
		["skipped", "skipped"],
	] as const)("projects %s title state", (status, expected) => {
		const projected = projectLaunchRunStartup(
			run(),
			evidence(),
			status === "failed" ? { status, safeSummary: "Rename it later" } : { status },
		);
		expect(projected.steps.find((step) => step.id === "choose_title")).toMatchObject({
			status: expected,
		});
	});

	it("continues projecting title evidence after startup has failed", () => {
		const failedEvidence = evidence({
			starts: [start({ kind: "bootstrap_failed", safeSummary: "Startup failed" } as never)],
		});
		const failedRun = projectLaunchRunStartup(run(), failedEvidence, { status: "pending" });

		const projected = projectLaunchRunStartup(failedRun, failedEvidence, { status: "completed" });

		expect(projected.status).toBe("failed");
		expect(projected.steps.find((step) => step.id === "choose_title")?.status).toBe("completed");
	});
});

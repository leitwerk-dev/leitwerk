import { describe, expect, it } from "vitest";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import { resolveAcceptedTurnStartReplay } from "./accepted-turn-start-replay.js";

function setup() {
	const deps = createTestDeps();
	const process = deps.processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
	});
	const lease = deps.leases.create({
		instanceId: process.id,
		workerId: "wkr_1",
		state: "idle",
	});
	deps.turnStarts.create({
		id: "tsr_1",
		instanceId: process.id,
		turnId: "generate_plan",
		turnType: "automatic",
		proposedTurnRecordId: "trn_1",
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: { kind: "automatic" },
			turnRecordId: "trn_1",
			acceptedWorkerLeaseId: lease.id,
		},
	});
	deps.turnRecords.create({
		id: "trn_1",
		instanceId: process.id,
		turnId: "generate_plan",
		turnType: "automatic",
		status: "running",
		attemptNumber: 1,
		parentTurnRecordId: null,
		turnStartRecordId: "tsr_1",
		acceptedWorkerLeaseId: lease.id,
		pathType: "primary",
		forkPiEntryId: null,
		resultPiEntryId: null,
		modelProfileId: null,
		turnResultMarkdown: null,
		errorSummary: null,
		errorClass: null,
		startedAt: "2026-04-14T10:00:00.000Z",
		endedAt: null,
	});
	deps.processes.update(process.id, {
		currentExecution: { kind: "worker_start", id: "tsr_1" },
	});
	return { deps, process, lease };
}

describe("resolveAcceptedTurnStartReplay", () => {
	it("replays the accepted running start to its idle owning worker", () => {
		const { deps, process } = setup();

		expect(resolveAcceptedTurnStartReplay(deps, process.id, "wkr_1")).toEqual({
			startRecordId: "tsr_1",
			turnRecordId: "trn_1",
			startedAt: "2026-04-14T10:00:00.000Z",
		});
	});

	it("does not replay after activation or to a different worker", () => {
		const { deps, process, lease } = setup();

		expect(resolveAcceptedTurnStartReplay(deps, process.id, "wkr_other")).toBeNull();
		deps.leases.update(lease.id, { state: "busy" });
		expect(resolveAcceptedTurnStartReplay(deps, process.id, "wkr_1")).toBeNull();
	});
});

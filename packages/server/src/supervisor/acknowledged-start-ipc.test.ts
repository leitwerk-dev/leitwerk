import type { WorkerBootstrapReceipt } from "@leitwerk-dev/domain";
import { createIpcMessage } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it, vi } from "vitest";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import { createIpcHandler } from "./ipc-handler.js";

function receipt(startRecordId: string, leaseId: string): WorkerBootstrapReceipt {
	return {
		kind: "automatic",
		startRecordId,
		workerLeaseId: leaseId,
		receiptEpoch: "epoch",
		readyAt: "now",
	};
}

function setup() {
	const deps = createTestDeps();
	const process = deps.processes.create({
		processId: "jira_issue_process",
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
	});
	deps.turnStarts.create({
		id: "start-1",
		instanceId: process.id,
		turnId: "generate_plan",
		turnType: "automatic",
		proposedTurnRecordId: "turn-1",
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: { kind: "starting", start: { kind: "automatic" } },
	});
	deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: "start-1" } });
	const workerId = "worker-1";
	const lease = deps.leases.create({ instanceId: process.id, workerId, state: "bootstrapping" });
	const acceptWorkerTurnStart = vi
		.fn()
		.mockResolvedValue({ ok: true, data: { turnRecordId: "turn-1" } });
	const callbacks = {
		onWorkerTurnStartAccepted: vi.fn(),
		onWorkerFailed: vi.fn(),
		onCredentialUpdateResult: vi.fn(),
	};
	const handler = createIpcHandler(
		{
			processes: deps.processes,
			projects: deps.projects,
			inputs: deps.inputs,
			events: deps.events,
			leases: deps.leases,
			turnRecords: deps.turnRecords,
			broadcaster: deps.broadcaster,
			commands: {
				acceptWorkerTurnStart,
				updateSemanticEntryRefs: vi.fn().mockResolvedValue({ ok: true }),
			} as never,
			updateCredential: vi.fn((input) =>
				input.expectedRevision === 2
					? { accepted: true, currentRevision: 3 }
					: { accepted: false, currentRevision: 3, safeReason: "Credential revision changed" },
			),
		},
		callbacks,
	);
	return { deps, process, workerId, lease, acceptWorkerTurnStart, callbacks, handler };
}

describe("acknowledged worker IPC", () => {
	it("stores a ready receipt once, permits exact replay, and rejects a changed receipt", () => {
		const t = setup();
		const payload = {
			receipt: receipt("start-1", t.lease.id),
			resumed: false,
			primaryTreeFile: "",
			workspaceRoot: "",
			aggregatedAgentsSources: [],
			loadedSkills: [],
			loadedAgentsFiles: [],
			loadedSkillFiles: [],
		};
		const ready = () =>
			createIpcMessage({
				type: "worker.ready",
				instanceId: t.process.id,
				workerId: t.workerId,
				messageId: crypto.randomUUID(),
				payload,
			});
		t.handler.handleMessage(ready());
		t.handler.handleMessage(ready());
		expect(t.deps.leases.getByInstance(t.process.id)?.bootstrapReceipt).toEqual(payload.receipt);
		t.handler.handleMessage(
			createIpcMessage({
				type: "worker.ready",
				instanceId: t.process.id,
				workerId: t.workerId,
				messageId: crypto.randomUUID(),
				payload: { ...payload, receipt: { ...payload.receipt, receiptEpoch: "changed" } },
			}),
		);
		expect(t.callbacks.onWorkerFailed).toHaveBeenCalled();
	});

	it("acknowledges accepted/replayed starts and rejects a failed acceptance", async () => {
		const t = setup();
		t.deps.leases.compareAndSetBootstrapReceipt(t.lease.id, receipt("start-1", t.lease.id));
		const start = () =>
			createIpcMessage({
				type: "worker.turn_started",
				instanceId: t.process.id,
				workerId: t.workerId,
				messageId: crypto.randomUUID(),
				payload: { startRecordId: "start-1", proposedTurnRecordId: "turn-1" },
			});
		t.handler.handleMessage(start());
		t.handler.handleMessage(start());
		await new Promise((resolve) => setImmediate(resolve));
		expect(t.callbacks.onWorkerTurnStartAccepted).toHaveBeenCalledTimes(2);
		t.acceptWorkerTurnStart.mockResolvedValueOnce({ ok: false });
		t.handler.handleMessage(start());
		await new Promise((resolve) => setImmediate(resolve));
		expect(t.callbacks.onWorkerFailed).toHaveBeenCalled();
	});

	it("returns credential CAS success and conflict without exposing values", () => {
		const t = setup();
		const update = (expectedRevision: number) =>
			createIpcMessage({
				type: "worker.credential_update",
				instanceId: t.process.id,
				workerId: t.workerId,
				messageId: crypto.randomUUID(),
				payload: { providerId: "p", expectedRevision, values: { secret: "never-log" } },
			});
		t.handler.handleMessage(update(2));
		t.handler.handleMessage(update(1));
		expect(t.callbacks.onCredentialUpdateResult).toHaveBeenNthCalledWith(
			1,
			t.process.id,
			t.workerId,
			{ providerId: "p", accepted: true, currentRevision: 3 },
		);
		expect(JSON.stringify(t.callbacks.onCredentialUpdateResult.mock.calls)).not.toContain(
			"never-log",
		);
		expect(t.callbacks.onCredentialUpdateResult).toHaveBeenLastCalledWith(
			t.process.id,
			t.workerId,
			expect.objectContaining({ accepted: false, currentRevision: 3 }),
		);
	});
});

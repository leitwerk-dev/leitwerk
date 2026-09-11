import { expect, it } from "vitest";
import { closeDatabase, createDatabase } from "../db/database.js";
import { createAllRepos } from "../db/repositories.js";
import { createBroadcaster } from "../ws/broadcast.js";
import { createStartupObserver } from "./startup-observer.js";
import { createWorkerEventIngestor } from "./worker-event-ingestor.js";

it("correlates initial prompt and text, rejects stale workers, thinking, empty output and later turns", () => {
	const db = createDatabase({ sqlitePath: ":memory:" });
	try {
		const repos = createAllRepos(db);
		const process = repos.processes.create({
			processId: "test",
			selectedTurnId: "draft",
			lifecycleStatus: "active",
		});
		for (const id of ["start", "later"])
			repos.turnStarts.create({
				id,
				instanceId: process.id,
				turnId: "draft",
				turnType: "llm",
				proposedTurnRecordId: `${id}-turn`,
				startKind: "selected_turn",
				recoveryTurnRecordId: null,
				continuation: null,
				state: { kind: "starting", start: {} as never },
			});
		const lease = repos.leases.create({
			instanceId: process.id,
			workerId: "worker",
			state: "busy",
			turnStartRecordId: "start",
		});
		const turn = repos.turnRecords.create({
			id: "start-turn",
			instanceId: process.id,
			turnId: "draft",
			acceptedWorkerLeaseId: lease.id,
			turnStartRecordId: "start",
			startedAt: "2026-09-11T10:00:00Z",
		});
		const ingestor = createWorkerEventIngestor({ ...repos, broadcaster: createBroadcaster() });
		ingestor.noteTurnStarted(process.id, turn.id);
		const send = (eventType: string, data: Record<string, unknown>, workerId = "worker") =>
			ingestor.ingestWorkerEvent({
				instanceId: process.id,
				workerId,
				payload: { eventType, data: { turnRecordId: turn.id, ...data } },
			});
		send("worker.trace", { code: "turn.prompt_started" }, "stale");
		send("pi.stream.delta", { streamType: "thinking", text: "reasoning" });
		send("pi.stream.delta", { streamType: "text", text: "" });
		expect(repos.startupObservations.listByLease(lease.id)).toEqual([]);
		send("worker.trace", { code: "turn.prompt_started" });
		send("pi.stream.delta", { streamType: "text", text: "hello" });
		const initial = repos.startupObservations.listByLease(lease.id);
		expect(initial.map((o) => o.milestone).sort()).toEqual(["first_text", "prompt_started"]);
		send("worker.trace", { code: "turn.prompt_started" });
		send("pi.stream.delta", { streamType: "text", text: "later" });
		expect(repos.startupObservations.listByLease(lease.id)).toEqual(initial);
		const later = repos.turnRecords.create({
			id: "later-turn",
			instanceId: process.id,
			turnId: "draft",
			acceptedWorkerLeaseId: lease.id,
			turnStartRecordId: "later",
			startedAt: "2026-09-11T10:01:00Z",
		});
		ingestor.noteTurnStarted(process.id, later.id);
		send("pi.stream.delta", { turnRecordId: later.id, streamType: "text", text: "later turn" });
		expect(repos.startupObservations.listByLease(lease.id)).toEqual(initial);
		const observer = createStartupObserver(repos, process.id, "worker", Date.now() + 10000);
		repos.leases.update(lease.id, { state: "exited", exitedAt: new Date().toISOString() });
		const replacement = repos.leases.create({
			instanceId: process.id,
			workerId: "replacement",
			state: "spawning",
		});
		expect(observer.shouldStop?.()).toBe(true);
		observer.observe?.({
			milestone: "pod_requested",
			observedAt: new Date().toISOString(),
			sourceAt: null,
			sourceKind: "server",
			objectUid: null,
			notBefore: null,
			metadata: {},
		});
		expect(repos.startupObservations.listByLease(replacement.id)).toEqual([]);
		expect(repos.startupObservations.listByLease(lease.id)).toEqual(initial);
	} finally {
		closeDatabase(db);
	}
});

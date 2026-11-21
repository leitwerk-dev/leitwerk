import { expect, test } from "vitest";
import {
	recordInterruptedTurnCandidates,
	retryInterruptedTurns,
} from "./dev-interrupted-turn-retry.ts";

test("retries only a failed record whose old worker reported the interruption", async () => {
	const calls: string[] = [];
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url.endsWith("/api/processes"))
			return Response.json({
				processes: [
					{
						process: { id: "p1", lifecycleStatus: "active" },
						workerLease: { id: "lease-1", workerId: "worker-1", state: "busy" },
					},
				],
			});
		if (url.endsWith("/api/processes/p1/diagnostics"))
			return Response.json({
				process: { id: "p1", lifecycleStatus: "active" },
				workerLease: { id: "lease-1", workerId: "worker-1", state: "busy" },
				turnRecords: [{ id: "turn-1", status: "running", acceptedWorkerLeaseId: "lease-1" }],
				events: [
					{
						id: "event-1",
						eventType: "worker_started",
						createdAt: "2026-01-01T00:00:00.000Z",
						data: {},
					},
				],
			});
		throw new Error(`Unexpected request ${url}`);
	};
	const candidates = await recordInterruptedTurnCandidates("http://127.0.0.1:1", fetchImpl);
	const retried = await retryInterruptedTurns(
		"http://127.0.0.1:1",
		candidates,
		async (input, init) => {
			const url = String(input);
			calls.push(`${init?.method ?? "GET"} ${url}`);
			if (url.endsWith("/diagnostics"))
				return Response.json({
					process: { id: "p1", lifecycleStatus: "error" },
					turnRecords: [{ id: "turn-1", status: "failed", acceptedWorkerLeaseId: "lease-1" }],
					events: [
						{
							id: "event-2",
							eventType: "worker_failed",
							createdAt: "2999-01-01T00:00:00.000Z",
							data: { workerId: "worker-1" },
						},
					],
				});
			if (url.endsWith("/retry")) return Response.json({ process: {} });
			throw new Error(`Unexpected request ${url}`);
		},
	);
	expect(retried).toBeUndefined();
	expect(calls.some((call) => call.includes("POST") && call.includes("/retry"))).toBe(true);
});

test("does not retry an earlier failure with no new old-worker failure event", async () => {
	const candidate = {
		instanceId: "p1",
		turnRecordId: "turn-1",
		workerLeaseId: "lease-1",
		workerId: "worker-1",
		observedAt: "2026-01-01T00:00:00.000Z",
		eventIds: new Set(["event-1"]),
	};
	let retried = false;
	await retryInterruptedTurns("http://127.0.0.1:1", [candidate], async (input) => {
		if (String(input).endsWith("/retry")) retried = true;
		return Response.json({
			process: { id: "p1", lifecycleStatus: "error" },
			turnRecords: [{ id: "turn-1", status: "failed", acceptedWorkerLeaseId: "lease-1" }],
			events: [
				{
					id: "event-1",
					eventType: "worker_failed",
					createdAt: "2025-01-01T00:00:00.000Z",
					data: { workerId: "worker-1" },
				},
			],
		});
	});
	expect(retried).toBe(false);
});

interface ProcessSummary {
	process: { id: string; lifecycleStatus: string };
	workerLease: { id: string; workerId: string; state: string } | null;
}

interface TurnRecord {
	id: string;
	status: string;
	acceptedWorkerLeaseId?: string | null;
}

interface ProcessDiagnostics {
	process: { id: string; lifecycleStatus: string };
	workerLease: { id: string; workerId: string; state: string } | null;
	turnRecords: TurnRecord[];
	events: Array<{
		id: string;
		eventType: string;
		createdAt: string;
		data: Record<string, unknown>;
	}>;
}

export interface InterruptedTurnCandidate {
	instanceId: string;
	turnRecordId: string;
	workerLeaseId: string;
	workerId: string;
	observedAt: string;
	eventIds: Set<string>;
}

export async function recordInterruptedTurnCandidates(
	baseUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<InterruptedTurnCandidate[]> {
	const response = await fetchImpl(new URL("/api/processes", baseUrl));
	if (response.status === 401 || response.status === 403)
		throw new Error("Interrupted-turn retry skipped; the backend requires authentication.");
	if (!response.ok) throw new Error(`Could not inspect running processes (${response.status})`);
	const body = (await response.json()) as { processes: ProcessSummary[] };
	const candidates: InterruptedTurnCandidate[] = [];
	for (const summary of body.processes) {
		const lease = summary.workerLease;
		if (!lease || lease.state !== "busy") continue;
		const detailResponse = await fetchImpl(
			new URL(`/api/processes/${summary.process.id}/diagnostics`, baseUrl),
		);
		if (!detailResponse.ok) continue;
		const detail = (await detailResponse.json()) as ProcessDiagnostics;
		const observedAt = new Date().toISOString();
		const eventIds = new Set(detail.events.map((event) => event.id));
		for (const turn of detail.turnRecords) {
			if (turn.status !== "running" || turn.acceptedWorkerLeaseId !== lease.id) continue;
			candidates.push({
				instanceId: summary.process.id,
				turnRecordId: turn.id,
				workerLeaseId: lease.id,
				workerId: lease.workerId,
				observedAt,
				eventIds,
			});
		}
	}
	return candidates;
}

export async function retryInterruptedTurns(
	baseUrl: string,
	candidates: readonly InterruptedTurnCandidate[],
	fetchImpl: typeof fetch = fetch,
	log: (message: string) => void = console.info,
): Promise<void> {
	for (const candidate of candidates) {
		const detailResponse = await fetchImpl(
			new URL(`/api/processes/${candidate.instanceId}/diagnostics`, baseUrl),
		);
		if (!detailResponse.ok) continue;
		const detail = (await detailResponse.json()) as ProcessDiagnostics;
		const turn = detail.turnRecords.find((record) => record.id === candidate.turnRecordId);
		const interrupted =
			detail.process.lifecycleStatus === "error" &&
			turn?.status === "failed" &&
			turn.acceptedWorkerLeaseId === candidate.workerLeaseId &&
			detail.events.some(
				(event) =>
					event.eventType === "worker_failed" &&
					event.data.workerId === candidate.workerId &&
					!candidate.eventIds.has(event.id) &&
					event.createdAt >= candidate.observedAt,
			);
		if (!interrupted) continue;
		const response = await fetchImpl(
			new URL(`/api/processes/${candidate.instanceId}/retry`, baseUrl),
			{ method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
		);
		if (response.status === 401 || response.status === 403) {
			log("[dev] Interrupted-turn retry skipped; the backend requires authentication.");
			return;
		}
		if (!response.ok) {
			log(`[dev] Interrupted-turn retry failed for ${candidate.instanceId} (${response.status}).`);
			continue;
		}
		log(`[dev] Retried turn ${candidate.turnRecordId} interrupted by the previous worker.`);
	}
}

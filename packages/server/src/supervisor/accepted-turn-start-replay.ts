import type { RepositoryBundle } from "../db/repositories.js";

export interface AcceptedTurnStartReplay {
	startRecordId: string;
	turnRecordId: string;
}

/** Resolve the durable accepted start that an idle owning worker must activate. */
export function resolveAcceptedTurnStartReplay(
	deps: Pick<RepositoryBundle, "leases" | "processes" | "turnRecords" | "turnStarts">,
	instanceId: string,
	workerId: string,
): AcceptedTurnStartReplay | null {
	const lease = deps.leases.getByInstance(instanceId);
	if (!lease || lease.workerId !== workerId || lease.state !== "idle") return null;

	const process = deps.processes.getById(instanceId);
	if (!process || process.currentExecution?.kind !== "worker_start") return null;

	const start = deps.turnStarts.getById(process.currentExecution.id);
	if (
		!start ||
		start.instanceId !== instanceId ||
		start.state.kind !== "accepted" ||
		start.state.acceptedWorkerLeaseId !== lease.id
	)
		return null;

	const turnRecord = deps.turnRecords.getById(start.state.turnRecordId);
	if (
		!turnRecord ||
		turnRecord.instanceId !== instanceId ||
		turnRecord.status !== "running" ||
		turnRecord.acceptedWorkerLeaseId !== lease.id
	)
		return null;

	return { startRecordId: start.id, turnRecordId: turnRecord.id };
}

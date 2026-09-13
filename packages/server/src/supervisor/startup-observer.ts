import type { StartupMilestone } from "@leitwerk-dev/domain";
import type { WorkerStartObserver } from "@leitwerk-dev/worker-runners/types";
import type { RepositoryBundle } from "../db/repositories.js";

type Deps = Pick<RepositoryBundle, "leases" | "processes"> &
	Partial<Pick<RepositoryBundle, "startupObservations">>;
export function createStartupObserver(
	deps: Deps,
	instanceId: string,
	workerId: string,
	deadlineMs: number,
): WorkerStartObserver {
	const lease = deps.leases.getByInstance(instanceId);
	return {
		report() {},
		shouldStop() {
			const current = lease && deps.leases.getById(lease.id);
			const process = deps.processes.getById(instanceId);
			return (
				!current ||
				current.workerId !== workerId ||
				current.exitedAt !== null ||
				Date.now() >= deadlineMs ||
				(current.readyAt != null && Date.now() >= Date.parse(current.readyAt) + 2000) ||
				!process ||
				["error", "aborted", "completed"].includes(process.lifecycleStatus)
			);
		},
		observe(observation) {
			if (!lease || lease.workerId !== workerId || !deps.startupObservations) return;
			const current = deps.leases.getByInstance(instanceId);
			if (current?.id !== lease.id || current.workerId !== workerId) return;
			try {
				const previous = deps.startupObservations.listByLease(lease.id);
				const isPvc = observation.milestone.startsWith("pvc_");
				if (
					observation.objectUid &&
					previous.some(
						(item) =>
							item.objectUid &&
							item.milestone.startsWith("pvc_") === isPvc &&
							item.objectUid !== observation.objectUid,
					)
				)
					return;
				deps.startupObservations.record({
					...observation,
					workerLeaseId: lease.id,
					turnRecordId: null,
				});
			} catch {
				/* Timing must not change lifecycle outcomes. */
			}
		},
	};
}
export function recordInitialTurnObservation(
	deps: Deps & Pick<RepositoryBundle, "turnRecords">,
	input: {
		instanceId: string;
		workerId: string;
		turnRecordId: string;
		milestone: StartupMilestone;
		observedAt: string;
	},
): void {
	const lease = deps.leases.getByInstance(input.instanceId);
	if (!lease || lease.workerId !== input.workerId || !deps.startupObservations) return;
	const turn = deps.turnRecords.getById(input.turnRecordId);
	const first = deps.turnRecords
		.listByInstance(input.instanceId)
		.filter((t) => t.acceptedWorkerLeaseId === lease.id)
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
	if (
		!turn ||
		first?.id !== turn.id ||
		turn.status !== "running" ||
		turn.instanceId !== input.instanceId ||
		turn.acceptedWorkerLeaseId !== lease.id ||
		turn.turnStartRecordId !== lease.turnStartRecordId
	)
		return;
	try {
		deps.startupObservations.record({
			workerLeaseId: lease.id,
			milestone: input.milestone,
			observedAt: input.observedAt,
			sourceAt: null,
			sourceKind: "server",
			objectUid: null,
			turnRecordId: turn.id,
			notBefore: null,
			metadata: { precision: "milliseconds" },
		});
	} catch {
		/* Diagnostics are independent of turn delivery. */
	}
}

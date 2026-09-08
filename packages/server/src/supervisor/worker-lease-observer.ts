import type { WorkerLease } from "@leitwerk-dev/domain";
import { createDurableWsFrame } from "@leitwerk-dev/protocol";
import type { RepositoryBundle } from "../db/repositories.js";
import {
	type AppliedWorkerLeaseObservationResult,
	type InvalidWorkerLeaseObservationResult,
	type NoopWorkerLeaseObservationResult,
	transitionWorkerLeaseState,
	type WorkerLeaseObservation,
} from "../domain-logic/worker-lease-lifecycle.js";
import type { Broadcaster } from "../ws/broadcast.js";

interface WorkerLeaseObserverDeps extends Pick<RepositoryBundle, "leases"> {
	broadcaster: Broadcaster;
}

export interface IgnoredWorkerLeaseObservationResult {
	kind: "ignored";
	reason: "no_active_lease" | "worker_id_mismatch";
	currentLease: WorkerLease | null;
}

export type ApplyWorkerLeaseObservationResult =
	| {
			kind: "applied";
			transition: AppliedWorkerLeaseObservationResult;
			lease: WorkerLease;
	  }
	| {
			kind: "noop";
			transition: NoopWorkerLeaseObservationResult;
			lease: WorkerLease | null;
	  }
	| {
			kind: "invalid";
			transition: InvalidWorkerLeaseObservationResult;
			lease: WorkerLease | null;
	  }
	| IgnoredWorkerLeaseObservationResult;

export function resolveActiveWorkerLease(
	leases: Pick<RepositoryBundle, "leases">["leases"],
	instanceId: string,
	workerId: string,
): WorkerLease | null {
	const lease = leases.getByInstance(instanceId);
	if (!lease || lease.workerId !== workerId) {
		return null;
	}
	return lease;
}

function broadcastWorkerState(
	broadcaster: Broadcaster,
	instanceId: string,
	lease: WorkerLease,
	previousState: WorkerLease["state"],
	reason: string,
): void {
	broadcaster.broadcast(
		createDurableWsFrame({
			type: "worker.state",
			payload: {
				worker: lease,
				workerId: lease.workerId,
				state: lease.state,
				previousState,
				reason,
			},
			instanceId,
		}),
	);
}

export function applyWorkerLeaseObservation(
	deps: WorkerLeaseObserverDeps,
	input: {
		instanceId: string;
		workerId: string;
		observation: WorkerLeaseObservation;
		reason?: string;
		exitedAt?: string;
		turnStartRecordId?: string | null;
	},
): ApplyWorkerLeaseObservationResult {
	const currentLease = deps.leases.getByInstance(input.instanceId);

	if (input.observation !== "spawn_requested") {
		if (!currentLease) {
			return {
				kind: "ignored",
				reason: "no_active_lease",
				currentLease: null,
			};
		}
		if (currentLease.workerId !== input.workerId) {
			return {
				kind: "ignored",
				reason: "worker_id_mismatch",
				currentLease,
			};
		}
	}

	const transition = transitionWorkerLeaseState(currentLease?.state ?? null, input.observation);
	if (transition.kind === "noop") {
		return { kind: "noop", transition, lease: currentLease ?? null };
	}
	if (transition.kind === "invalid") {
		return { kind: "invalid", transition, lease: currentLease ?? null };
	}

	const reason = input.reason ?? input.observation;
	if (input.observation === "spawn_requested") {
		const lease = deps.leases.create({
			instanceId: input.instanceId,
			workerId: input.workerId,
			state: transition.to,
			turnStartRecordId: input.turnStartRecordId ?? null,
		});
		broadcastWorkerState(deps.broadcaster, input.instanceId, lease, transition.from, reason);
		return { kind: "applied", transition, lease };
	}

	if (!currentLease) {
		return {
			kind: "ignored",
			reason: "no_active_lease",
			currentLease: null,
		};
	}

	const lease = deps.leases.update(currentLease.id, {
		state: transition.to,
		...(transition.to === "exited" ? { exitedAt: input.exitedAt ?? new Date().toISOString() } : {}),
	});
	if (!lease) {
		return {
			kind: "ignored",
			reason: "no_active_lease",
			currentLease: null,
		};
	}

	broadcastWorkerState(deps.broadcaster, input.instanceId, lease, transition.from, reason);
	return { kind: "applied", transition, lease };
}

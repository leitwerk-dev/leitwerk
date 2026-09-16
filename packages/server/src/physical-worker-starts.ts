import {
	type PhysicalWorkerStart,
	type ProcessTurnRecord,
	type StartupObservation,
	startupInterval,
	type TurnStartRecord,
	type WorkerLease,
} from "@leitwerk-dev/domain";
export function physicalWorkerStarts(input: {
	leases: readonly WorkerLease[];
	turnStarts: readonly TurnStartRecord[];
	turnRecords: readonly ProcessTurnRecord[];
	observations: readonly StartupObservation[];
}): PhysicalWorkerStart[] {
	return input.leases.map((lease) => {
		const start = input.turnStarts.find((start) => start.id === lease.turnStartRecordId);
		const turn = input.turnRecords
			.filter(
				(turn) => turn.acceptedWorkerLeaseId === lease.id && turn.turnStartRecordId === start?.id,
			)
			.sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
		const observations = input.observations.filter((o) => o.workerLeaseId === lease.id);
		const observation = (milestone: StartupObservation["milestone"]) =>
			observations.find((o) => o.milestone === milestone);
		const receipt = (milestone: StartupObservation["milestone"]) =>
			observation(milestone)?.observedAt;
		const source = (milestone: StartupObservation["milestone"]) => observation(milestone)?.sourceAt;
		return {
			workerLeaseId: lease.id,
			workerId: lease.workerId,
			turnStartRecordId: lease.turnStartRecordId ?? null,
			turnRecordId: turn?.id ?? null,
			state: lease.state,
			observations,
			intervals: {
				launchPreparation: startupInterval(start?.createdAt, lease.startedAt),
				requestToConnection: startupInterval(lease.startedAt, lease.connectedAt),
				connectionToReadiness: startupInterval(lease.connectedAt, lease.readyAt),
				readinessToAcceptance: startupInterval(lease.readyAt, turn?.startedAt),
				acceptanceToPrompt: startupInterval(turn?.startedAt, receipt("prompt_started")),
				promptToFirstText: startupInterval(receipt("prompt_started"), receipt("first_text")),
				total: startupInterval(start?.createdAt, receipt("first_text")),
				pvcRequest: startupInterval(receipt("pvc_requested"), receipt("pvc_acknowledged")),
				podRequest: startupInterval(receipt("pod_requested"), receipt("pod_acknowledged")),
				bindingWindow: startupInterval(observation("pvc_bound")?.notBefore, receipt("pvc_bound")),
				containerObservedToConnection: startupInterval(
					receipt("container_started"),
					lease.connectedAt,
				),
				scheduling: startupInterval(source("pod_created"), source("pod_scheduled"), "kubernetes"),
				schedulingToContainer: startupInterval(
					source("pod_scheduled"),
					source("container_started"),
					"kubernetes",
				),
				imagePull: startupInterval(
					source("image_pull_started"),
					source("image_pull_finished"),
					"kubernetes",
				),
			},
		};
	});
}

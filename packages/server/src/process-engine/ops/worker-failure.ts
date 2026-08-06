import { accept, noWrites } from "../decision.js";
import { defineOperation } from "../operation.js";
import { selectedTurnRequiresWorker } from "../turn-worker-requirement.js";
import { buildWorkerFailureWrites } from "../writes/build-worker-failure-writes.js";

export interface WorkerFailureInput {
	instanceId: string;
	payload: {
		errorCode: string;
		message: string;
		errorClass?: import("@leitwerk-dev/domain").WorkerErrorClass;
		workerLeaseId?: string | null;
	};
}

export const WorkerFailure = defineOperation<"worker_failure", WorkerFailureInput, void>({
	kind: "worker_failure",
	label: "Worker failure",
	decide(ctx, input) {
		const activeLease = ctx.deps.leases.getByInstance(ctx.process.id);
		if (
			input.payload.workerLeaseId &&
			(!activeLease || activeLease.id !== input.payload.workerLeaseId)
		) {
			// A late failure from a replaced physical worker must never park the
			// start or turn now owned by the current lease.
			return noWrites();
		}
		const currentStart =
			ctx.process.currentExecution?.kind === "worker_start"
				? ctx.deps.turnStarts.getById(ctx.process.currentExecution.id)
				: null;
		if (currentStart?.state.kind === "starting") {
			if (ctx.process.lifecycleStatus !== "active") return noWrites();
			return accept({
				writes: {
					turnStartWrites: [
						{
							kind: "cas_state",
							id: currentStart.id,
							expectedKind: "starting",
							state: {
								kind: "bootstrap_failed",
								start: currentStart.state.start,
								failedWorkerLeaseId: activeLease?.id ?? null,
								code: input.payload.errorCode,
								safeSummary: input.payload.message,
							},
						},
					],
					processPatch: { lifecycleStatus: "error" },
					changedFields: ["lifecycleStatus"],
					workerIntent: {
						kind: "stop_with_reason",
						reason: `worker_failed:${input.payload.errorCode}`,
					},
				},
			});
		}
		const activeTurnRecord =
			currentStart?.state.kind === "accepted"
				? ctx.deps.turnRecords.getById(currentStart.state.turnRecordId)
				: ctx.process.currentExecution?.kind === "server_turn"
					? ctx.deps.turnRecords.getById(ctx.process.currentExecution.id)
					: null;
		const runningTurnRecord = activeTurnRecord?.status === "running" ? activeTurnRecord : null;
		if (runningTurnRecord === null) {
			if (ctx.process.lifecycleStatus === "error") {
				return noWrites();
			}
			if (!selectedTurnRequiresWorker(ctx.deps.processGraphs, ctx.process)) {
				return accept({
					writes: {
						workerIntent: {
							kind: "stop_with_reason",
							reason: `worker_failed:${input.payload.errorCode}`,
						},
					},
				});
			}
		}
		return accept({
			writes: buildWorkerFailureWrites({
				process: ctx.process,
				message: input.payload.message,
				errorCode: input.payload.errorCode,
				errorClass: input.payload.errorClass,
				activeTurnRecord: runningTurnRecord,
			}),
		});
	},
});

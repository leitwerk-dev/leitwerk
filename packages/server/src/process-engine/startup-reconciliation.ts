import type { ProcessInstance, WorkerLease } from "@leitwerk-dev/domain";
import type { LeitwerkConfig } from "../config/config-types.js";
import type { RepositoryBundle } from "../db/repositories.js";
import type { PiResourceBundlePinReconciler } from "../pi-resources/index.js";
import type { ProcessActionRegistry } from "../process-action-registry.js";
import { applyWorkerLeaseObservation } from "../supervisor/worker-lease-observer.js";
import type { WorkerSupervisor } from "../supervisor/worker-supervisor.js";
import type { Broadcaster } from "../ws/broadcast.js";
import type { ProcessEngine } from "./types.js";

interface LoggerLike {
	info?: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
	error?: (...args: unknown[]) => void;
}

export interface StartupReconciliationDeps
	extends Pick<RepositoryBundle, "processes" | "leases" | "turnStarts" | "turnRecords"> {
	config: LeitwerkConfig;
	broadcaster: Broadcaster;
	supervisor: WorkerSupervisor;
	commands: Partial<Pick<ProcessEngine, "recordWorkerFailure">>;
	bundlePins?: PiResourceBundlePinReconciler;
	processActionRegistry: ProcessActionRegistry;
	logger?: LoggerLike;
}

export function shouldResumeProcessOnStartup(
	process: Pick<ProcessInstance, "selectedTurnId" | "lifecycleStatus" | "currentExecution">,
	config: Pick<LeitwerkConfig, "workers">,
): boolean {
	if (!config.workers.resume_on_boot || process.lifecycleStatus !== "active") {
		return false;
	}
	if (!process.selectedTurnId || process.currentExecution === null) {
		return false;
	}
	return true;
}

function reclaimPersistedLease(
	deps: Pick<StartupReconciliationDeps, "leases" | "broadcaster" | "logger">,
	lease: WorkerLease,
): void {
	if (lease.state === "exited") {
		if (!lease.exitedAt) {
			deps.leases.update(lease.id, { exitedAt: new Date().toISOString() });
		}
		return;
	}

	const result = applyWorkerLeaseObservation(
		{ leases: deps.leases, broadcaster: deps.broadcaster },
		{
			instanceId: lease.instanceId,
			workerId: lease.workerId,
			observation: "process_exited",
			reason: "server_boot_reconciliation",
		},
	);

	if (result.kind === "applied") {
		return;
	}

	deps.logger?.warn?.(
		{
			instanceId: lease.instanceId,
			workerId: lease.workerId,
			leaseState: lease.state,
			result,
		},
		"Failed to reclaim persisted worker lease during startup reconciliation",
	);
}

export async function reconcileProcessesOnStartup(deps: StartupReconciliationDeps): Promise<void> {
	const processes = deps.processes.listAll();
	const staleLeases = deps.leases.listActive();
	const missingLocalBundleProcesses = new Set<string>();
	for (const process of processes) {
		const missingDigest = deps.bundlePins?.reconcile(process).missingDigest;
		if (!missingDigest || deps.config.workers.runner !== "local") continue;
		await deps.commands.recordWorkerFailure?.(process.id, {
			errorCode: "pi_resource_bundle_unavailable",
			message: "The Pi resource bundle for this worker start is unavailable",
		});
		if (deps.commands.recordWorkerFailure) missingLocalBundleProcesses.add(process.id);
	}

	for (const lease of staleLeases) {
		const worker = deps.supervisor.getWorker(lease.instanceId);
		if (worker?.workerId === lease.workerId) {
			continue;
		}
		reclaimPersistedLease(deps, lease);
	}

	let resumedCount = 0;
	for (const process of processes) {
		if (missingLocalBundleProcesses.has(process.id)) continue;
		if (!shouldResumeProcessOnStartup(process, deps.config)) {
			continue;
		}
		try {
			const adoptedOrRunningWorker = deps.supervisor.getWorker(process.id);
			if (process.currentExecution?.kind !== "worker_start") continue;
			const start = deps.turnStarts.getById(process.currentExecution.id);
			const reusable =
				start?.instanceId === process.id &&
				(start.state.kind === "starting" ||
					(start.state.kind === "accepted" &&
						deps.turnRecords.getById(start.state.turnRecordId)?.status === "running"));
			if (!reusable) {
				deps.logger?.warn?.(
					{ instanceId: process.id },
					"Skipping invalid current worker-start execution during startup reconciliation",
				);
				continue;
			}
			if (adoptedOrRunningWorker) {
				// Adoption already verified that the lease fingerprint matches the
				// current effective runtime model and worker-consumed Pi configuration.
				continue;
			}
			await deps.supervisor.spawnWorker(process.id);
			resumedCount += 1;
		} catch (error) {
			deps.logger?.error?.(
				{
					err: error,
					instanceId: process.id,
					processId: process.processId,
					selectedTurnId: process.selectedTurnId,
					lifecycleStatus: process.lifecycleStatus,
				},
				"Failed to auto-resume active process on startup",
			);
		}
	}

	deps.logger?.info?.(
		{
			processCount: processes.length,
			staleLeaseCount: staleLeases.length,
			resumedCount,
			resumeOnBoot: deps.config.workers.resume_on_boot,
		},
		"Startup reconciliation complete",
	);
}

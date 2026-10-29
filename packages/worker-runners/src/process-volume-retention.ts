import type { ProcessInstance } from "@leitwerk-dev/domain";
import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { ProcessVolume } from "./types.js";

/** @internal */
export interface ProcessVolumeRetentionPolicy {
	/** @internal */
	completedProcessRetention: string;
	/** Defaults to error retention for callers retaining non-volume artifacts. @internal */
	abortedProcessRetention?: string;
	/** @internal */
	errorProcessRetention: string;
}

/** @internal */
export interface PlanProcessVolumeRetentionCleanupInput {
	/** @internal */
	processes: readonly ProcessInstance[];
	/** @internal */
	now: Date;
	/** @internal */
	policy: ProcessVolumeRetentionPolicy;
	/** @internal */
	alreadyReleased?: ReadonlySet<string>;
}

function retentionMs(value: string): number {
	return parseDurationMs(value, Number.POSITIVE_INFINITY, { allowHours: true });
}

function closedAtMs(process: ProcessInstance): number | null {
	if (!process.closedAt) {
		return null;
	}
	const parsed = Date.parse(process.closedAt);
	return Number.isFinite(parsed) ? parsed : null;
}

/** @internal */
export function planProcessVolumeRetentionCleanup(
	input: PlanProcessVolumeRetentionCleanupInput,
): string[] {
	const completedRetentionMs = retentionMs(input.policy.completedProcessRetention);
	const abortedRetentionMs = retentionMs(
		input.policy.abortedProcessRetention ?? input.policy.errorProcessRetention,
	);
	const errorRetentionMs = retentionMs(input.policy.errorProcessRetention);
	const nowMs = input.now.getTime();
	const alreadyReleased = input.alreadyReleased ?? new Set<string>();
	const candidates: string[] = [];
	for (const process of input.processes) {
		if (alreadyReleased.has(process.id)) {
			continue;
		}
		const closed = closedAtMs(process);
		if (closed === null) {
			continue;
		}
		const retention =
			process.lifecycleStatus === "completed"
				? completedRetentionMs
				: process.lifecycleStatus === "aborted"
					? abortedRetentionMs
					: process.lifecycleStatus === "error"
						? errorRetentionMs
						: Number.POSITIVE_INFINITY;
		if (nowMs - closed >= retention) {
			candidates.push(process.id);
		}
	}
	return candidates;
}

/** @internal */
export async function cleanupRetainedProcessVolumes(input: {
	/** @internal */
	volume?: ProcessVolume;
	/** Terminal-process storage disposal policy; error retention is unaffected. @internal */
	reclaimTerminalBackingStorage?: boolean;
	/** @internal */
	processes: readonly ProcessInstance[];
	/** @internal */
	now: Date;
	/** @internal */
	policy: ProcessVolumeRetentionPolicy;
	/** @internal */
	alreadyReleased?: ReadonlySet<string>;
}): Promise<string[]> {
	const candidates = planProcessVolumeRetentionCleanup(input);
	if (input.volume) {
		for (const instanceId of candidates) {
			const process = input.processes.find((process) => process.id === instanceId);
			if (
				input.reclaimTerminalBackingStorage &&
				process?.closedAt &&
				(process.lifecycleStatus === "completed" || process.lifecycleStatus === "aborted")
			) {
				await input.volume.release(instanceId, {
					reclaimBackingStorage: {
						lifecycleStatus: process.lifecycleStatus,
						closedAt: process.closedAt,
					},
				});
			} else {
				await input.volume.release(instanceId);
			}
		}
	}
	return candidates;
}

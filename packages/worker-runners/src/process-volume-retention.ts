import type { ProcessInstance } from "@leitwerk-dev/domain";
import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { ProcessVolume } from "./types.js";

export interface ProcessVolumeRetentionPolicy {
	completedProcessRetention: string;
	errorProcessRetention: string;
}

export interface PlanProcessVolumeRetentionCleanupInput {
	processes: readonly ProcessInstance[];
	now: Date;
	policy: ProcessVolumeRetentionPolicy;
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

export function planProcessVolumeRetentionCleanup(
	input: PlanProcessVolumeRetentionCleanupInput,
): string[] {
	const completedRetentionMs = retentionMs(input.policy.completedProcessRetention);
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
				: process.lifecycleStatus === "aborted" || process.lifecycleStatus === "error"
					? errorRetentionMs
					: Number.POSITIVE_INFINITY;
		if (nowMs - closed >= retention) {
			candidates.push(process.id);
		}
	}
	return candidates;
}

export async function cleanupRetainedProcessVolumes(input: {
	volume?: ProcessVolume;
	processes: readonly ProcessInstance[];
	now: Date;
	policy: ProcessVolumeRetentionPolicy;
	alreadyReleased?: ReadonlySet<string>;
}): Promise<string[]> {
	const candidates = planProcessVolumeRetentionCleanup(input);
	if (input.volume) {
		for (const instanceId of candidates) {
			await input.volume.release(instanceId);
		}
	}
	return candidates;
}

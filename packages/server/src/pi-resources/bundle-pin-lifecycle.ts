import type { ProcessInstance } from "@leitwerk-dev/domain";
import type { RepositoryBundle } from "../db/repositories.js";
import type { PiResourceBundleCache } from "./bundle-cache.js";

export interface PiResourceBundlePinReconciler {
	reconcile(process: ProcessInstance): { missingDigest: string | null };
}

function pinnedDigest(
	process: ProcessInstance,
	turnStarts: Pick<RepositoryBundle["turnStarts"], "getById">,
	turnRecords: Pick<RepositoryBundle["turnRecords"], "getById">,
): string | null {
	if (process.currentExecution?.kind !== "worker_start") return null;
	const start = turnStarts.getById(process.currentExecution.id);
	if (!start || start.instanceId !== process.id || start.turnType !== "llm") return null;
	if (start.state.kind === "starting" && start.state.start.kind === "llm") {
		return start.state.start.piResourceSnapshotDigest;
	}
	if (
		start.state.kind === "accepted" &&
		start.state.start.kind === "llm" &&
		turnRecords.getById(start.state.turnRecordId)?.status === "running"
	) {
		return start.state.start.piResourceSnapshotDigest;
	}
	return null;
}

/** Keeps only the current live LLM start's resource bundle retained in this server. */
export function createPiResourceBundlePinReconciler(
	deps: Pick<RepositoryBundle, "turnStarts" | "turnRecords"> & {
		bundleCache: PiResourceBundleCache;
	},
): PiResourceBundlePinReconciler {
	const pinnedByInstance = new Map<string, string>();

	return {
		reconcile(process) {
			const next = pinnedDigest(process, deps.turnStarts, deps.turnRecords);
			const previous = pinnedByInstance.get(process.id) ?? null;
			if (previous === next) {
				return { missingDigest: next && !deps.bundleCache.has(next) ? next : null };
			}
			if (previous) deps.bundleCache.unpin(previous);
			if (!next) {
				pinnedByInstance.delete(process.id);
				return { missingDigest: null };
			}
			if (!deps.bundleCache.pin(next)) {
				return { missingDigest: next };
			}
			pinnedByInstance.set(process.id, next);
			return { missingDigest: null };
		},
	};
}

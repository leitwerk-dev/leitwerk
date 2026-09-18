/** First server receipt of a physical worker startup milestone. @internal */
export type StartupMilestone =
	| "pvc_requested"
	| "pvc_acknowledged"
	| "pvc_bound"
	| "pod_requested"
	| "pod_acknowledged"
	| "pod_created"
	| "pod_scheduled"
	| "image_pull_started"
	| "image_pull_finished"
	| "image_cached"
	| "container_started"
	| "prompt_started"
	| "first_text";
/** @internal */
export interface StartupObservation {
	/** @internal */
	workerLeaseId: string;
	/** @internal */
	milestone: StartupMilestone;
	/** @internal */
	observedAt: string;
	/** @internal */
	sourceAt: string | null;
	/** @internal */
	sourceKind: "server" | "kubernetes_status" | "kubernetes_event";
	/** @internal */
	objectUid: string | null;
	/** @internal */
	turnRecordId: string | null;
	/** Sampling lower bound, never an exact binding timestamp. @internal */
	notBefore: string | null;
	/** @internal */
	metadata: {
		/** @internal */
		node?: string;
		/** @internal */
		imageId?: string;
		/** @internal */
		image?: string;
		/** @internal */
		storageClass?: string;
		/** @internal */
		cpu?: string;
		/** @internal */
		memory?: string;
		/** @internal */
		namespace?: string;
		/** @internal */
		podName?: string;
		/** @internal */
		precision?: "milliseconds" | "microseconds" | "seconds" | "sampling_interval";
	};
}
/** @internal */
export interface StartupInterval {
	/** @internal */
	start: string | null;
	/** @internal */
	end: string | null;
	/** @internal */
	durationMs: number | null;
	/** @internal */
	status: "available" | "missing" | "invalid_order";
	/** @internal */
	clock: "server" | "kubernetes";
}
/** @internal */
export function startupInterval(
	start: string | null | undefined,
	end: string | null | undefined,
	clock: StartupInterval["clock"] = "server",
): StartupInterval {
	const delta = start && end ? Date.parse(end) - Date.parse(start) : NaN;
	const status =
		!start || !end
			? "missing"
			: !Number.isFinite(delta) || delta < 0
				? "invalid_order"
				: "available";
	return {
		start: start ?? null,
		end: end ?? null,
		durationMs: status === "available" ? delta : null,
		status,
		clock,
	};
}
/** @internal */
export interface PhysicalWorkerStart {
	/** @internal */
	workerLeaseId: string;
	/** @internal */
	workerId: string;
	/** @internal */
	turnStartRecordId: string | null;
	/** @internal */
	turnRecordId: string | null;
	/** @internal */
	state: string;
	/** @internal */
	observations: StartupObservation[];
	/** @internal */
	intervals: Record<string, StartupInterval>;
}

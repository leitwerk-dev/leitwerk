/** First server receipt of a physical worker startup milestone. */
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
export interface StartupObservation {
	workerLeaseId: string;
	milestone: StartupMilestone;
	observedAt: string;
	sourceAt: string | null;
	sourceKind: "server" | "kubernetes_status" | "kubernetes_event";
	objectUid: string | null;
	turnRecordId: string | null;
	/** Sampling lower bound, never an exact binding timestamp. */
	notBefore: string | null;
	metadata: {
		node?: string;
		imageId?: string;
		image?: string;
		storageClass?: string;
		cpu?: string;
		memory?: string;
		namespace?: string;
		podName?: string;
		precision?: "milliseconds" | "microseconds" | "seconds" | "sampling_interval";
	};
}
export interface StartupInterval {
	start: string | null;
	end: string | null;
	durationMs: number | null;
	status: "available" | "missing" | "invalid_order";
	clock: "server" | "kubernetes";
}
export interface PhysicalWorkerStart {
	workerLeaseId: string;
	workerId: string;
	turnStartRecordId: string | null;
	turnRecordId: string | null;
	state: string;
	observations: StartupObservation[];
	intervals: Record<string, StartupInterval>;
}

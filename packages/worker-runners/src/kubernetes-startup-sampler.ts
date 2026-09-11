import type { StartupMilestone, StartupObservation } from "@leitwerk-dev/domain";
import type { KubernetesApiClient } from "./kubernetes-api-client.js";
import type { WorkerStartObserver } from "./types.js";
import { parseWorkerUnitIdentity } from "./worker-labels.js";
export function startupReceipt(
	observer: WorkerStartObserver | undefined,
	milestone: StartupMilestone,
	metadata: StartupObservation["metadata"] = {},
): void {
	try {
		observer?.observe?.({
			milestone,
			observedAt: new Date().toISOString(),
			sourceAt: null,
			sourceKind: "server",
			objectUid: null,
			notBefore: null,
			metadata,
		});
	} catch {
		/* Observation cannot fail startup. */
	}
}
/** One asynchronous collection cycle per physical worker. Never awaited by lifecycle work. */
export function sampleKubernetesStartup(
	client: KubernetesApiClient,
	observer: WorkerStartObserver,
	namespace: string,
	pvcName: string,
) {
	let pod: { name: string; workerId: string; instanceId: string } | undefined;
	let podUid: string | undefined;
	let pvcUid: string | undefined;
	let lastUnbound: string | null = null;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let active: AbortController | undefined;
	let failures = 0;
	const seen = new Set<StartupMilestone>();
	const deadline = Date.now() + 120_000;
	const emit = (
		milestone: StartupMilestone,
		objectUid: string,
		sourceAt: string | null,
		metadata: StartupObservation["metadata"],
		sourceKind: StartupObservation["sourceKind"] = "kubernetes_status",
		notBefore: string | null = null,
	) => {
		if (
			stopped ||
			seen.has(milestone) ||
			(sourceAt !== null && !Number.isFinite(Date.parse(sourceAt)))
		)
			return;
		observer.observe?.({
			milestone,
			observedAt: new Date().toISOString(),
			sourceAt,
			objectUid,
			sourceKind,
			notBefore,
			metadata,
		});
		seen.add(milestone);
	};
	const stop = () => {
		stopped = true;
		if (timer) clearTimeout(timer);
		active?.abort();
	};
	const cycle = async () => {
		if (stopped || observer.shouldStop?.() || Date.now() >= deadline) {
			stop();
			return;
		}
		active = new AbortController();
		const timeout = setTimeout(() => active?.abort(), 1500);
		const signal = active.signal;
		try {
			if (!seen.has("pvc_bound") && client.getPersistentVolumeClaim) {
				const pvc = await client.getPersistentVolumeClaim(pvcName, namespace, { signal });
				if (pvc?.uid) {
					if (pvcUid && pvcUid !== pvc.uid) {
						stop();
						return;
					}
					pvcUid = pvc.uid;
					if (pvc.phase === "Bound")
						emit(
							"pvc_bound",
							pvc.uid,
							null,
							{ storageClass: pvc.storageClass, precision: "sampling_interval" },
							"kubernetes_status",
							lastUnbound,
						);
					else lastUnbound = new Date().toISOString();
				}
			}
			if (pod) {
				const summary = await client.getPod(pod.name, namespace, { signal });
				if (!summary) {
					stop();
					return;
				}
				const identity = parseWorkerUnitIdentity(summary.labels);
				if (
					!identity ||
					identity.workerId !== pod.workerId ||
					identity.instanceId !== pod.instanceId ||
					(podUid && podUid !== summary.uid)
				) {
					stop();
					return;
				}
				if (summary.uid) {
					podUid = summary.uid;
					const metadata = {
						node: summary.node,
						imageId: summary.imageId,
						namespace,
						podName: pod.name,
						...summary.resources,
						precision: "seconds" as const,
					};
					if (summary.createdAt) emit("pod_created", podUid, summary.createdAt, metadata);
					if (summary.scheduledAt) emit("pod_scheduled", podUid, summary.scheduledAt, metadata);
					if (summary.containerStartedAt)
						emit("container_started", podUid, summary.containerStartedAt, metadata);
					const events = await client.listPodEvents(pod.name, namespace, { signal });
					for (const event of events) {
						if (event.objectUid !== podUid || event.fieldPath !== "spec.containers{worker}")
							continue;
						const at = event.eventTime || event.firstTimestamp;
						if (!at) continue;
						if (event.reason === "Pulling")
							emit("image_pull_started", podUid, at, metadata, "kubernetes_event");
						if (event.reason === "Pulled")
							emit(
								event.message?.includes("already present") ? "image_cached" : "image_pull_finished",
								podUid,
								at,
								metadata,
								"kubernetes_event",
							);
					}
				}
				if (summary.phase === "Failed" || summary.phase === "Succeeded") stop();
			}
			if (
				seen.has("container_started") &&
				seen.has("pod_scheduled") &&
				seen.has("pvc_bound") &&
				(seen.has("image_cached") ||
					(seen.has("image_pull_started") && seen.has("image_pull_finished")))
			)
				stop();
		} catch {
			if (!stopped && failures++ < 3)
				console.warn("Worker startup observation unavailable: Kubernetes collection failed");
		} finally {
			clearTimeout(timeout);
			active = undefined;
			if (!stopped) {
				timer = setTimeout(() => void cycle(), 250);
				timer.unref?.();
			}
		}
	};
	timer = setTimeout(() => void cycle(), 0);
	timer.unref?.();
	return {
		stop,
		attachPod(input: NonNullable<typeof pod>) {
			pod = input;
		},
	};
}

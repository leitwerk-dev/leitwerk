import { POOL_LABEL } from "./kubernetes-volume-pool.js";
import type { VolumePoolApi } from "./kubernetes-volume-pool-api.js";
import type { ProcessVolumeReclamation } from "./types.js";

/** Persist ownership and any terminal disposal authorization before PVC deletion. @internal */
export async function retireKubernetesProcessVolume(input: {
	/** @internal */
	api: VolumePoolApi;
	/** @internal */
	namespace: string;
	/** @internal */
	name: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	signal: AbortSignal;
	/** @internal */
	reason?: "retention-expired" | "process-deleted";
	/** @internal */
	reclaimBackingStorage?: ProcessVolumeReclamation | "process-deleted";
}): Promise<void> {
	const { api, namespace, name, instanceId, signal } = input;
	const reclamation = input.reclaimBackingStorage;
	if (
		typeof reclamation === "object" &&
		(!["completed", "aborted"].includes(reclamation.lifecycleStatus) ||
			!Number.isFinite(Date.parse(reclamation.closedAt)) ||
			Date.parse(reclamation.closedAt) > Date.now())
	)
		throw new Error("Backing-storage reclamation requires a closed terminal process");
	if (reclamation === "process-deleted" && input.reason !== "process-deleted")
		throw new Error("Explicit storage deletion requires a process deletion request");
	const pvc = await api.get("persistentvolumeclaims", namespace, name, signal);
	if (!pvc) return;
	const labels = pvc.metadata.labels;
	if (
		!pvc.metadata.uid ||
		labels?.["leitwerk.dev/managed-by"] !== "leitwerk" ||
		labels["leitwerk.dev/component"] !== "process-volume" ||
		labels["leitwerk.dev/instance-id"] !== instanceId ||
		pvc.metadata.ownerReferences?.length
	)
		throw new Error("Cannot retire a foreign or ambiguous process PVC");
	if (reclamation && !pvc.spec.volumeName)
		throw new Error(
			"PVC is still provisioning; preserve its identity until the backing PV can be audited",
		);
	const pods = await api.list("pods", namespace, "", signal);
	if (
		pods.some(
			(pod) =>
				!["Succeeded", "Failed"].includes(pod.status?.phase ?? "") &&
				Array.isArray(pod.spec.volumes) &&
				pod.spec.volumes.some(
					(volume) =>
						(volume as { persistentVolumeClaim?: { claimName?: string } }).persistentVolumeClaim
							?.claimName === name,
				),
		)
	)
		throw new Error("Cannot retire a process volume referenced by a live Pod");
	if (pvc.spec.volumeName) {
		const pv = await api.get("persistentvolumes", "", pvc.spec.volumeName, signal);
		if (
			!pv ||
			(pv.metadata.labels?.["leitwerk.dev/managed-by"] !== undefined &&
				pv.metadata.labels["leitwerk.dev/managed-by"] !== "leitwerk") ||
			(pv.metadata.labels?.["leitwerk.dev/instance-id"] !== undefined &&
				pv.metadata.labels["leitwerk.dev/instance-id"] !== instanceId) ||
			pv.metadata.ownerReferences?.length ||
			pv.metadata.deletionTimestamp ||
			pv.spec.claimRef?.uid !== pvc.metadata.uid ||
			pv.spec.claimRef?.name !== name ||
			pv.spec.claimRef?.namespace !== namespace
		)
			throw new Error("Cannot retire a volume with ambiguous claim ownership");
		const csi = pv.spec.csi as { driver?: string; volumeHandle?: string } | undefined;
		if (
			reclamation &&
			(!csi?.driver ||
				!csi.volumeHandle ||
				pv.metadata.annotations?.["pv.kubernetes.io/provisioned-by"] !== csi.driver ||
				!["Retain", "Delete"].includes(pv.spec.persistentVolumeReclaimPolicy ?? ""))
		)
			throw new Error(
				"Backing-storage reclamation requires an owned dynamically provisioned CSI volume",
			);
		const volumeLabels: Record<string, string> = {
			...pv.metadata.labels,
			"leitwerk.dev/managed-by": "leitwerk",
			"leitwerk.dev/component": "process-volume",
			"leitwerk.dev/instance-id": instanceId,
			...(reclamation ? { "leitwerk.dev/reclamation": "terminal" } : {}),
		};
		// End pool ownership atomically: a stale pool reconciler must not restore
		// Retain after a fast process closes. Both writers use resourceVersion tests.
		delete volumeLabels[POOL_LABEL];
		await api.patchVolume(
			pv,
			[
				{
					op: "add",
					path: "/metadata/labels",
					value: volumeLabels,
				},
				{
					op: "add",
					path: "/metadata/annotations",
					value: {
						...pv.metadata.annotations,
						"leitwerk.dev/retirement": JSON.stringify({
							instanceId,
							namespace,
							claimName: name,
							claimUid: pvc.metadata.uid,
							volumeUid: pv.metadata.uid,
							reason: input.reason ?? "retention-expired",
							...(reclamation
								? {
										reclamation:
											typeof reclamation === "object"
												? { policy: "terminal-process", ...reclamation }
												: { policy: "process-deletion" },
									}
								: {}),
						}),
					},
				},
				// Arm CSI reclamation before deleting the claim. A crash after this
				// patch is safe: retry either repeats it or CSI completes independently.
				...(reclamation
					? [{ op: "add", path: "/spec/persistentVolumeReclaimPolicy", value: "Delete" }]
					: []),
			],
			signal,
		);
	}
	await api.delete("persistentvolumeclaims", namespace, pvc, signal);
}

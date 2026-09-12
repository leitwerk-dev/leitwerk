import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PoolObject, VolumePoolApi } from "./kubernetes-volume-pool-api.js";

export const POOL_LABEL = "leitwerk.dev/volume-pool";
const CLAIM_UID = "leitwerk.dev/preparation-claim-uid";
const CLAIM_NAME = "leitwerk.dev/preparation-claim-name";
const POLICY = "leitwerk.dev/original-reclaim-policy";
const TARGET_CLASS = "leitwerk.dev/target-storage-class";
const STATE = "leitwerk.dev/volume-pool-state";
const SIZE = "leitwerk.dev/preparation-size";
const MODES = "leitwerk.dev/preparation-access-modes";

export interface VolumePoolOptions {
	api: VolumePoolApi;
	namespace: string;
	count: number;
	storageClassName: string;
	size: string;
	accessModes: string[];
	image: string;
	imagePullPolicy?: string;
	imagePullSecrets?: string[];
	nodeSelector?: Record<string, string>;
	tolerations?: unknown[];
	onError?: () => void;
}

/** Only the staging claim's UID authorizes rebinding; process claims are never recycled. */
export function createKubernetesVolumePool(options: VolumePoolOptions) {
	const { api, namespace } = options;
	if (!Number.isSafeInteger(options.count) || options.count < 0)
		throw new Error("Invalid volume pool count");
	const poolId = createHash("sha256")
		.update(`${namespace}/${options.storageClassName}`)
		.digest("hex")
		.slice(0, 16);
	const selector = `${POOL_LABEL}=${poolId}`;
	const labels = {
		"leitwerk.dev/managed-by": "leitwerk",
		[POOL_LABEL]: poolId,
		"leitwerk.dev/component": "volume-preparation",
	};
	let controller: AbortController | undefined;
	let running: Promise<void> | undefined;

	function preparationPod(claim: PoolObject): PoolObject {
		return {
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name: claim.metadata.name,
				namespace,
				labels,
				ownerReferences: [
					{
						apiVersion: "v1",
						kind: "PersistentVolumeClaim",
						name: claim.metadata.name,
						uid: claim.metadata.uid ?? "",
					},
				],
			},
			spec: {
				restartPolicy: "Never",
				serviceAccountName: "default",
				automountServiceAccountToken: false,
				nodeSelector: options.nodeSelector ?? {},
				tolerations: options.tolerations ?? [],
				imagePullSecrets: (options.imagePullSecrets ?? []).map((name) => ({ name })),
				containers: [
					{
						name: "prepare",
						image: options.image,
						imagePullPolicy: options.imagePullPolicy ?? "IfNotPresent",
						command: ["node", "-e", "process.exit(0)"],
						resources: {
							requests: { cpu: "1m", memory: "32Mi" },
							limits: { cpu: "100m", memory: "64Mi" },
						},
						securityContext: {
							allowPrivilegeEscalation: false,
							readOnlyRootFilesystem: true,
							capabilities: { drop: ["ALL"] },
						},
						volumeMounts: [{ name: "volume", mountPath: "/volume" }],
					},
				],
				volumes: [{ name: "volume", persistentVolumeClaim: { claimName: claim.metadata.name } }],
			},
		};
	}

	async function advanceVolume(pv: PoolObject, signal: AbortSignal): Promise<boolean> {
		const annotations = pv.metadata.annotations ?? {};
		const uid = annotations[CLAIM_UID];
		const name = annotations[CLAIM_NAME];
		const policy = annotations[POLICY];
		if (!uid || !name || !["Delete", "Retain"].includes(policy))
			throw new Error("Invalid prepared-volume ownership");
		if (pv.metadata.deletionTimestamp) return false;
		const claim = pv.spec.claimRef;
		if (claim && claim.uid !== uid) {
			// A process has consumed this PV, including if it was already released again.
			const remainingLabels = { ...pv.metadata.labels };
			delete remainingLabels[POOL_LABEL];
			await api.patchVolume(
				pv,
				[
					{ op: "add", path: "/spec/persistentVolumeReclaimPolicy", value: policy },
					{ op: "add", path: "/metadata/labels", value: remainingLabels },
				],
				signal,
			);
			return false;
		}
		if (claim) {
			if (pv.spec.persistentVolumeReclaimPolicy !== "Retain")
				throw new Error("Staging PV must be retained before release");
			const pod = await api.get("pods", namespace, name, signal);
			if (pod) {
				if (
					pod.metadata.labels?.[POOL_LABEL] !== poolId ||
					!pod.metadata.ownerReferences?.some((owner) => owner.uid === uid)
				)
					throw new Error("Preparation Pod ownership mismatch");
				await api.delete("pods", namespace, pod, signal);
				return true;
			}
			const pvc = await api.get("persistentvolumeclaims", namespace, name, signal);
			if (pvc) {
				if (pvc.metadata.uid !== uid) throw new Error("Preparation PVC ownership mismatch");
				await api.delete("persistentvolumeclaims", namespace, pvc, signal);
				return true;
			}
			if (pv.status?.phase === "Released") {
				await api.patchVolume(
					pv,
					[
						{ op: "test", path: "/spec/claimRef/uid", value: uid },
						{ op: "remove", path: "/spec/claimRef" },
					],
					signal,
				);
			}
			return true;
		}
		// Never restore Delete while the old Released status remains: a provisioner could reclaim it.
		if (pv.status?.phase === "Available" && annotations[STATE] !== "ready") {
			const stagingClass = await api.getStorageClass(name, signal);
			if (stagingClass) {
				if (stagingClass.metadata.labels?.[POOL_LABEL] !== poolId)
					throw new Error("Staging StorageClass ownership mismatch");
				await api.deleteStorageClass(stagingClass, signal);
				return true;
			}
			const targetClass = annotations[TARGET_CLASS];
			if (!targetClass) throw new Error("Target StorageClass is missing");
			await api.patchVolume(
				pv,
				[
					{ op: "add", path: "/spec/persistentVolumeReclaimPolicy", value: policy },
					{ op: "add", path: "/spec/storageClassName", value: targetClass },
					{ op: "add", path: "/metadata/annotations", value: { ...annotations, [STATE]: "ready" } },
				],
				signal,
			);
		}
		return (
			annotations[STATE] !== "ready" ||
			(annotations[SIZE] === options.size &&
				annotations[MODES] === JSON.stringify(options.accessModes))
		);
	}

	async function reconcile(signal: AbortSignal) {
		const volumes = await api.list("persistentvolumes", "", selector, signal);
		const classes = await api.listStorageClasses(selector, signal);
		const active = new Set<string>(classes.map((value) => value.metadata.name));
		for (const pv of volumes) {
			if (await advanceVolume(pv, signal)) active.add(pv.metadata.annotations?.[CLAIM_NAME] ?? "");
		}
		const claims = await api.list("persistentvolumeclaims", namespace, selector, signal);
		for (const claim of claims) {
			active.add(claim.metadata.name);
			if (!claim.metadata.uid || claim.spec.storageClassName !== claim.metadata.name)
				throw new Error("Invalid staging PVC identity");
			if (
				claim.metadata.deletionTimestamp ||
				volumes.some((pv) => pv.metadata.annotations?.[CLAIM_UID] === claim.metadata.uid)
			)
				continue;
			const pod = await api.get("pods", namespace, claim.metadata.name, signal);
			if (!pod) {
				await api.create("pods", namespace, preparationPod(claim), signal);
				continue;
			}
			if (
				pod.metadata.labels?.[POOL_LABEL] !== poolId ||
				!pod.metadata.ownerReferences?.some((owner) => owner.uid === claim.metadata.uid)
			)
				throw new Error("Preparation Pod ownership mismatch");
			if (pod.status?.phase === "Failed") {
				await api.delete("pods", namespace, pod, signal);
				continue;
			}
			if (pod.status?.phase !== "Succeeded" || !claim.spec.volumeName) continue;
			const pv = await api.get("persistentvolumes", "", claim.spec.volumeName, signal);
			if (
				!pv ||
				pv.spec.claimRef?.uid !== claim.metadata.uid ||
				pv.metadata.ownerReferences?.length ||
				pv.metadata.deletionTimestamp
			)
				throw new Error("Cannot safely retain staging volume");
			if (pv.metadata.labels?.[POOL_LABEL]) throw new Error("PV already belongs to a pool");
			const policy = pv.spec.persistentVolumeReclaimPolicy;
			if (!policy || !["Delete", "Retain"].includes(policy))
				throw new Error("Unsupported reclaim policy");
			await api.patchVolume(
				pv,
				[
					{
						op: "add",
						path: "/metadata/labels",
						value: { ...pv.metadata.labels, [POOL_LABEL]: poolId },
					},
					{
						op: "add",
						path: "/metadata/annotations",
						value: {
							...pv.metadata.annotations,
							[CLAIM_UID]: claim.metadata.uid,
							[CLAIM_NAME]: claim.metadata.name,
							[POLICY]: policy,
							[STATE]: "preparing",
							[TARGET_CLASS]: options.storageClassName,
							[SIZE]: claim.metadata.annotations?.[SIZE],
							[MODES]: claim.metadata.annotations?.[MODES],
						},
					},
					{ op: "add", path: "/spec/persistentVolumeReclaimPolicy", value: "Retain" },
				],
				signal,
			);
		}
		for (const stagingClass of classes) {
			const name = stagingClass.metadata.name;
			if (
				stagingClass.metadata.deletionTimestamp ||
				claims.some((claim) => claim.metadata.name === name) ||
				volumes.some((pv) => pv.metadata.annotations?.[CLAIM_NAME] === name)
			)
				continue;
			await api.create(
				"persistentvolumeclaims",
				namespace,
				{
					apiVersion: "v1",
					kind: "PersistentVolumeClaim",
					metadata: {
						name,
						namespace,
						labels,
						annotations: {
							[SIZE]: stagingClass.metadata.annotations?.[SIZE] ?? "",
							[MODES]: stagingClass.metadata.annotations?.[MODES] ?? "",
						},
					},
					spec: {
						storageClassName: name,
						accessModes: JSON.parse(stagingClass.metadata.annotations?.[MODES] ?? "null"),
						volumeMode: "Filesystem",
						resources: {
							requests: {
								storage: stagingClass.metadata.annotations?.[SIZE],
							},
						},
					},
				},
				signal,
			);
		}
		if (active.size < options.count) {
			const source = await api.getStorageClass(options.storageClassName, signal);
			if (!source || ["kubernetes.io/no-provisioner", "manual"].includes(source.provisioner))
				throw new Error("Volume pre-provisioning requires a dynamic StorageClass");
			for (let i = active.size; i < options.count; i++) {
				signal.throwIfAborted();
				// A unique staging class prevents preparation PVCs from consuming the ready pool.
				await api.createStorageClass(
					{
						apiVersion: "storage.k8s.io/v1",
						kind: "StorageClass",
						metadata: {
							name: `lw-volume-${randomUUID()}`,
							labels,
							annotations: {
								...Object.fromEntries(
									Object.entries(source.metadata.annotations ?? {}).filter(
										([key]) =>
											![
												"storageclass.kubernetes.io/is-default-class",
												"storageclass.beta.kubernetes.io/is-default-class",
												"kubectl.kubernetes.io/last-applied-configuration",
											].includes(key),
									),
								),
								[SIZE]: options.size,
								[MODES]: JSON.stringify(options.accessModes),
							},
						},
						provisioner: source.provisioner,
						parameters: source.parameters,
						reclaimPolicy: source.reclaimPolicy,
						mountOptions: source.mountOptions,
						allowVolumeExpansion: source.allowVolumeExpansion,
						volumeBindingMode: source.volumeBindingMode,
						allowedTopologies: source.allowedTopologies,
					},
					signal,
				);
			}
		}
	}

	return {
		poolId,
		reconcile,
		start() {
			if (controller) return;
			controller = new AbortController();
			const { signal } = controller;
			running = (async () => {
				while (!signal.aborted) {
					let interval = 2_000;
					try {
						await reconcile(signal);
					} catch {
						interval = 30_000;
						if (!signal.aborted) options.onError?.();
					}
					try {
						await delay(interval, undefined, { signal });
					} catch {
						break;
					}
				}
			})();
		},
		async stop() {
			controller?.abort();
			await running;
			controller = undefined;
		},
	};
}

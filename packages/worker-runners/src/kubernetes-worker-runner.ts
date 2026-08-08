import { readFileSync } from "node:fs";
import type { KubernetesApiClient } from "./kubernetes-api-client.js";
import {
	buildKubernetesDockerConfigJsonSecretManifest,
	buildKubernetesProcessNamespaceManifest,
	buildKubernetesProcessPvcManifest,
	buildKubernetesServerCaConfigMapManifest,
	buildKubernetesWorkerPodManifest,
	KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY,
	KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME,
	KUBERNETES_WORKER_SERVER_CA_MOUNT_PATH,
	type KubernetesPodSpecOptions,
	type KubernetesProcessVolumeSpec,
	kubernetesProcessNamespaceName,
	kubernetesProcessPvcName,
	volumeRefFromPvc,
} from "./kubernetes-manifests.js";
import { UnitExitNotifier } from "./runner-utils.js";
import type {
	IsolatedStartWorkerInput,
	ProcessVolume,
	StopWorkerOptions,
	WorkerRunner,
	WorkerUnit,
	WorkerUnitDescriptor,
	WorkerUnitRef,
} from "./types.js";
import {
	managedProcessNamespaceLabelSelector,
	managedWorkerLabelSelector,
	parseWorkerUnitIdentity,
	WORKER_LABEL_COMPONENT,
	WORKER_LABEL_INSTANCE_ID,
	WORKER_LABEL_MANAGED_BY,
	WORKER_LABEL_MANAGED_BY_VALUE,
} from "./worker-labels.js";

export interface KubernetesWorkerRunnerOptions {
	client: KubernetesApiClient;
	/** Prefix used to derive one Kubernetes namespace per process instance. */
	processNamespacePrefix: string;
	volume: KubernetesProcessVolumeSpec;
	/** Server-local CA bundle copied into each process namespace for worker TLS trust. */
	serverCaFile?: string;
	/** Namespace containing operator-managed source image-pull Secrets. */
	serverNamespace?: string;
	/** Docker registry Secrets copied into every process namespace. */
	imagePullSecretCopies?: Array<{ sourceName: string; targetName: string }>;
	pod?: Omit<KubernetesPodSpecOptions, "namespace">;
}

export function createKubernetesWorkerRunner(options: KubernetesWorkerRunnerOptions): {
	runner: WorkerRunner<IsolatedStartWorkerInput>;
	volume: ProcessVolume;
} {
	const { client } = options;
	const serverCaFile = options.serverCaFile?.trim();
	const namespaceForProcess = (instanceId: string) =>
		kubernetesProcessNamespaceName(instanceId, options.processNamespacePrefix);

	const volume: ProcessVolume = {
		async ensure(instanceId) {
			const namespaceManifest = buildKubernetesProcessNamespaceManifest({
				instanceId,
				processNamespacePrefix: options.processNamespacePrefix,
			});
			await client.ensureNamespace(namespaceManifest);
			for (const copy of options.imagePullSecretCopies ?? []) {
				const dockerConfigJson = await client.getDockerConfigJsonSecret(
					copy.sourceName,
					options.serverNamespace ?? "leitwerk-system",
				);
				await client.ensureDockerConfigJsonSecret(
					buildKubernetesDockerConfigJsonSecretManifest({
						instanceId,
						namespace: namespaceManifest.metadata.name,
						name: copy.targetName,
						dockerConfigJson,
					}),
				);
			}
			if (serverCaFile) {
				await client.ensureConfigMap(
					buildKubernetesServerCaConfigMapManifest({
						instanceId,
						namespace: namespaceManifest.metadata.name,
						caPem: readFileSync(serverCaFile, "utf8"),
					}),
				);
			}
			const workerServiceAccount = options.pod?.workerServiceAccount?.trim();
			if (workerServiceAccount && workerServiceAccount !== "default") {
				await client.ensureServiceAccount(workerServiceAccount, namespaceManifest.metadata.name, {
					[WORKER_LABEL_MANAGED_BY]: WORKER_LABEL_MANAGED_BY_VALUE,
					[WORKER_LABEL_COMPONENT]: "worker-service-account",
					[WORKER_LABEL_INSTANCE_ID]: instanceId,
				});
			}
			const manifest = buildKubernetesProcessPvcManifest({
				instanceId,
				namespace: namespaceManifest.metadata.name,
				volume: options.volume,
			});
			await client.ensurePersistentVolumeClaim(manifest);
			return volumeRefFromPvc({
				instanceId,
				pvcName: manifest.metadata.name,
				mountPath: options.volume.mountPath,
				namespace: manifest.metadata.namespace,
			});
		},
		async release(instanceId) {
			await client.deletePersistentVolumeClaim(
				kubernetesProcessPvcName(instanceId, options.volume.namePrefix),
				namespaceForProcess(instanceId),
			);
		},
		async deleteProcessResources(instanceId) {
			await client.deleteNamespace(namespaceForProcess(instanceId));
		},
	};

	const exitNotifier = new UnitExitNotifier();
	const unsubscribers = new Map<string, () => void>();

	function unitKey(namespace: string, unitId: string): string {
		return `${namespace}/${unitId}`;
	}

	function watchPod(unitId: string, namespace: string): void {
		const key = unitKey(namespace, unitId);
		if (unsubscribers.has(key)) return;
		const unsubscribe = client.onPodExit(unitId, namespace, (info) => {
			exitNotifier.fireExit(key, info);
			unsubscribers.get(key)?.();
			unsubscribers.delete(key);
		});
		unsubscribers.set(key, unsubscribe);
	}

	const runner: WorkerRunner<IsolatedStartWorkerInput> = {
		async start(input: IsolatedStartWorkerInput): Promise<WorkerUnit> {
			if (input.isolation.dind !== false) {
				throw new Error("Kubernetes worker runner does not support Docker-in-Docker profiles");
			}
			const processNamespace = input.volume.namespace ?? namespaceForProcess(input.instanceId);
			const manifest = buildKubernetesWorkerPodManifest(input, {
				namespace: processNamespace,
				...(options.pod ?? {}),
				...(serverCaFile
					? {
							serverCaConfigMap: {
								name: KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME,
								key: KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY,
								mountPath: KUBERNETES_WORKER_SERVER_CA_MOUNT_PATH,
							},
						}
					: {}),
			});
			await client.createPod(manifest);
			const ref: WorkerUnitRef = {
				instanceId: input.instanceId,
				workerId: input.workerId,
				unitId: manifest.metadata.name,
				namespace: manifest.metadata.namespace,
			};
			watchPod(ref.unitId, ref.namespace ?? processNamespace);
			return exitNotifier.wrapUnit(ref, unitKey(ref.namespace ?? processNamespace, ref.unitId));
		},
		async stop(ref: WorkerUnitRef, opts: StopWorkerOptions): Promise<void> {
			await client.deletePod(ref.unitId, ref.namespace ?? namespaceForProcess(ref.instanceId), {
				gracePeriodSeconds: Math.max(0, Math.ceil(opts.graceMs / 1000)),
			});
		},
		async list(): Promise<WorkerUnitDescriptor[]> {
			const namespaces = await client.listNamespaces(managedProcessNamespaceLabelSelector());
			const descriptors: WorkerUnitDescriptor[] = [];
			for (const namespace of namespaces) {
				if (!namespace.name.startsWith(options.processNamespacePrefix)) continue;
				const pods = await client.listPods(namespace.name, managedWorkerLabelSelector());
				for (const pod of pods) {
					const identity = parseWorkerUnitIdentity(pod.labels);
					if (!identity) continue;
					descriptors.push({
						instanceId: identity.instanceId,
						workerId: identity.workerId,
						unitId: pod.name,
						namespace: pod.namespace,
						observedState:
							pod.phase === "Failed" || pod.phase === "Succeeded"
								? "terminal"
								: pod.phase === "Pending"
									? "pending"
									: pod.phase === "Running"
										? "running"
										: "unknown",
					});
				}
			}
			return descriptors;
		},
		async adopt(descriptor: WorkerUnitDescriptor): Promise<WorkerUnit> {
			const podNamespace = descriptor.namespace ?? namespaceForProcess(descriptor.instanceId);
			const pod = await client.getPod(descriptor.unitId, podNamespace);
			const identity = pod ? parseWorkerUnitIdentity(pod.labels) : null;
			if (
				!identity ||
				identity.instanceId !== descriptor.instanceId ||
				identity.workerId !== descriptor.workerId
			) {
				throw new Error(`Cannot adopt worker pod ${descriptor.unitId}: labels changed`);
			}
			if (!pod || pod.phase === "Failed" || pod.phase === "Succeeded") {
				throw new Error(`Cannot adopt worker pod ${descriptor.unitId}: not running`);
			}
			const ref: WorkerUnitRef = {
				instanceId: descriptor.instanceId,
				workerId: descriptor.workerId,
				unitId: descriptor.unitId,
				namespace: podNamespace,
			};
			watchPod(ref.unitId, podNamespace);
			return exitNotifier.wrapUnit(ref, unitKey(podNamespace, ref.unitId));
		},
	};

	return { runner, volume };
}

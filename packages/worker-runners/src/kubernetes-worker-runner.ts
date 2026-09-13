import { readFileSync } from "node:fs";
import {
	createHelperProcessStateExporter,
	exportHelperEnvironment,
} from "./helper-process-state-exporter.js";
import type { KubernetesApiClient } from "./kubernetes-api-client.js";
import {
	buildKubernetesDockerConfigJsonSecretManifest,
	buildKubernetesExportHelperPodManifest,
	buildKubernetesProcessNamespaceManifest,
	buildKubernetesProcessPvcManifest,
	buildKubernetesServerCaConfigMapManifest,
	buildKubernetesWorkerPodManifest,
	KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY,
	KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME,
	KUBERNETES_WORKER_SERVER_CA_MOUNT_PATH,
	type KubernetesDockerPodSpecOptions,
	type KubernetesPodSpecOptions,
	type KubernetesProcessVolumeSpec,
	kubernetesExportHelperPodName,
	kubernetesProcessNamespaceName,
	kubernetesProcessPvcName,
	redactKubernetesDiagnostic,
	volumeRefFromPvc,
} from "./kubernetes-manifests.js";
import { sampleKubernetesStartup, startupReceipt } from "./kubernetes-startup-sampler.js";
import { UnitExitNotifier } from "./runner-utils.js";
import {
	SESSION_TRANSFER_HELPER_ENTRY_PATH,
	SESSION_TRANSFER_HELPER_MOUNT_PATH,
} from "./session-transfer-helper.js";
import type {
	IsolatedStartWorkerInput,
	ProcessStateExporter,
	ProcessStateExportHelperRelayProvider,
	ProcessVolume,
	StopWorkerOptions,
	WorkerRunner,
	WorkerUnit,
	WorkerUnitDescriptor,
	WorkerUnitRef,
} from "./types.js";
import { WorkerStartDiagnosticError } from "./types.js";
import {
	managedExportHelperLabelSelector,
	managedProcessNamespaceLabelSelector,
	managedWorkerLabelSelector,
	parseWorkerUnitIdentity,
	WORKER_LABEL_COMPONENT,
	WORKER_LABEL_INSTANCE_ID,
	WORKER_LABEL_MANAGED_BY,
	WORKER_LABEL_MANAGED_BY_VALUE,
} from "./worker-labels.js";

const KUBERNETES_START_DIAGNOSTIC_MAX_LENGTH = 2_048;

function boundedKubernetesStartDiagnostic(
	error: unknown,
	sensitiveValues: readonly string[],
): string {
	const detail = error instanceof Error ? error.message : "Kubernetes Pod admission failed";
	return redactKubernetesDiagnostic(detail, sensitiveValues).slice(
		0,
		KUBERNETES_START_DIAGNOSTIC_MAX_LENGTH,
	);
}

export interface KubernetesWorkerRunnerOptions {
	client: KubernetesApiClient;
	/** Prefix used to derive one Kubernetes namespace per process instance. */
	processNamespacePrefix: string;
	volume: KubernetesProcessVolumeSpec;
	/** Storage and Pod wiring for process definitions that require private Docker. */
	docker?: KubernetesDockerPodSpecOptions & { processStorageClassName: string };
	/** Maximum wait after deletion before replacement is rejected. */
	podDisappearanceTimeoutMs?: number;
	podDisappearancePollIntervalMs?: number;
	/** Test seam for bounded disappearance polling. */
	delay?: (ms: number) => Promise<void>;
	/** Server-local CA bundle copied into each process namespace for worker TLS trust. */
	serverCaFile?: string;
	/** Namespace containing operator-managed source image-pull Secrets. */
	serverNamespace?: string;
	/** Docker registry Secrets copied into every process namespace. */
	imagePullSecretCopies?: Array<{ sourceName: string; targetName: string }>;
	pod?: Omit<KubernetesPodSpecOptions, "namespace">;
	/** Stable internal URL used by PVC export helpers. */
	serverUrl?: string;
	/** Trusted image containing the bundled session-transfer helper entrypoint. */
	exporterImage?: string;
	/** Pull policy for the trusted helper image. */
	exporterImagePullPolicy?: string;
	/** Server-owned relay registry used by PVC export helpers. */
	helperRelays?: ProcessStateExportHelperRelayProvider;
}

export function createKubernetesWorkerRunner(options: KubernetesWorkerRunnerOptions): {
	runner: WorkerRunner<IsolatedStartWorkerInput>;
	volume: ProcessVolume;
	exporter: ProcessStateExporter;
} {
	if (!options.serverUrl || !options.exporterImage || !options.helperRelays) {
		throw new Error("Kubernetes transfer exporter is not configured");
	}
	const { client } = options;
	const exporterServerUrl = options.serverUrl;
	const exporterImage = options.exporterImage;
	const helperRelays = options.helperRelays;
	const serverCaFile = options.serverCaFile?.trim();
	const namespaceForProcess = (instanceId: string) =>
		kubernetesProcessNamespaceName(instanceId, options.processNamespacePrefix);
	const delay =
		options.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	const podDisappearanceTimeoutMs = options.podDisappearanceTimeoutMs ?? 30_000;
	const podDisappearancePollIntervalMs = options.podDisappearancePollIntervalMs ?? 250;

	const samplers = new Map<string, ReturnType<typeof sampleKubernetesStartup>>();
	const volume: ProcessVolume = {
		async ensure(instanceId, requirements, observer) {
			const namespaceManifest = buildKubernetesProcessNamespaceManifest({
				instanceId,
				processNamespacePrefix: options.processNamespacePrefix,
			});
			await client.ensureNamespace(namespaceManifest);
			const copySecrets = (options.imagePullSecretCopies ?? []).map(async (copy) => {
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
			});
			const workerServiceAccount = options.pod?.workerServiceAccount?.trim();
			const manifest = buildKubernetesProcessPvcManifest({
				instanceId,
				namespace: namespaceManifest.metadata.name,
				volume:
					requirements?.docker && options.docker
						? { ...options.volume, storageClassName: options.docker.processStorageClassName }
						: options.volume,
			});
			await Promise.all([
				...copySecrets,
				...(serverCaFile
					? [
							client.ensureConfigMap(
								buildKubernetesServerCaConfigMapManifest({
									instanceId,
									namespace: namespaceManifest.metadata.name,
									caPem: readFileSync(serverCaFile, "utf8"),
								}),
							),
						]
					: []),
				...(workerServiceAccount && workerServiceAccount !== "default"
					? [
							client.ensureServiceAccount(workerServiceAccount, namespaceManifest.metadata.name, {
								[WORKER_LABEL_MANAGED_BY]: WORKER_LABEL_MANAGED_BY_VALUE,
								[WORKER_LABEL_COMPONENT]: "worker-service-account",
								[WORKER_LABEL_INSTANCE_ID]: instanceId,
							}),
						]
					: []),
				(async () => {
					startupReceipt(observer, "pvc_requested", {
						storageClass: manifest.spec.storageClassName,
					});
					await client.ensurePersistentVolumeClaim(manifest);
					startupReceipt(observer, "pvc_acknowledged", {
						storageClass: manifest.spec.storageClassName,
					});
					if (observer?.observe) {
						samplers.get(instanceId)?.stop();
						samplers.set(
							instanceId,
							sampleKubernetesStartup(
								client,
								observer,
								manifest.metadata.namespace,
								manifest.metadata.name,
							),
						);
					}
				})(),
			]);
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
			samplers.get(instanceId)?.stop();
			samplers.delete(instanceId);
			await client.deleteNamespace(namespaceForProcess(instanceId));
		},
	};

	const exitNotifier = new UnitExitNotifier();
	const unsubscribers = new Map<string, () => void>();
	const disappearancePromises = new Map<string, Promise<void>>();

	function unitKey(namespace: string, unitId: string): string {
		return `${namespace}/${unitId}`;
	}

	function deletePodAndWait(
		name: string,
		namespace: string,
		gracePeriodSeconds: number,
	): Promise<void> {
		const key = unitKey(namespace, name);
		const existing = disappearancePromises.get(key);
		if (existing) return existing;
		const operation = Promise.resolve()
			.then(async () => {
				const deadline = Date.now() + podDisappearanceTimeoutMs;
				const timeoutError = new Error(
					`Kubernetes worker Pod ${namespace}/${name} did not disappear within ${podDisappearanceTimeoutMs}ms; replacement was not started`,
				);
				const controller = new AbortController();
				const { signal } = controller;
				let rejectTimeout!: (error: Error) => void;
				const timedOut = new Promise<never>((_resolve, reject) => {
					rejectTimeout = reject;
				});
				const timer = setTimeout(() => {
					controller.abort(timeoutError);
					rejectTimeout(timeoutError);
				}, podDisappearanceTimeoutMs);
				const waitForDisappearance = async () => {
					await client.deletePod(name, namespace, { gracePeriodSeconds, signal });
					while (true) {
						signal.throwIfAborted();
						if (Date.now() >= deadline) throw timeoutError;
						const pod = await client.getPod(name, namespace, { signal });
						signal.throwIfAborted();
						if (Date.now() >= deadline) throw timeoutError;
						if (!pod) return;
						await delay(
							Math.min(podDisappearancePollIntervalMs, Math.max(0, deadline - Date.now())),
						);
					}
				};
				try {
					await Promise.race([waitForDisappearance(), timedOut]);
				} catch (error) {
					if (signal.aborted) throw timeoutError;
					throw error;
				} finally {
					clearTimeout(timer);
				}
			})
			.finally(() => disappearancePromises.delete(key));
		disappearancePromises.set(key, operation);
		return operation;
	}

	function watchPod(
		unitId: string,
		namespace: string,
		sensitiveValues: readonly string[] = [],
	): void {
		const key = unitKey(namespace, unitId);
		if (unsubscribers.has(key)) return;
		const unsubscribe = client.onPodExit(
			unitId,
			namespace,
			(info) => {
				exitNotifier.fireExit(key, info);
				unsubscribers.get(key)?.();
				unsubscribers.delete(key);
			},
			{ sensitiveValues },
		);
		unsubscribers.set(key, unsubscribe);
	}

	const runner: WorkerRunner<IsolatedStartWorkerInput> = {
		async start(input: IsolatedStartWorkerInput, observer): Promise<WorkerUnit> {
			observer?.report("preparing_runtime");
			if (input.docker && !options.docker) {
				throw new Error(
					"Kubernetes Docker runtime is unavailable; configure kubernetes.docker completely",
				);
			}
			const processNamespace = input.volume.namespace ?? namespaceForProcess(input.instanceId);
			const manifest = buildKubernetesWorkerPodManifest(input, {
				namespace: processNamespace,
				...(options.pod ?? {}),
				...(input.docker && options.docker ? { docker: options.docker } : {}),
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
			observer?.report("allocating_runtime");
			try {
				startupReceipt(observer, "pod_requested", {
					image: input.image.reference,
					...input.resources,
				});
				await client.createPod(manifest);
				startupReceipt(observer, "pod_acknowledged");
				samplers.get(input.instanceId)?.attachPod({
					name: manifest.metadata.name,
					workerId: input.workerId,
					instanceId: input.instanceId,
				});
			} catch (error) {
				samplers.get(input.instanceId)?.stop();
				samplers.delete(input.instanceId);
				throw new WorkerStartDiagnosticError(
					boundedKubernetesStartDiagnostic(error, Object.values(input.env)),
					error,
				);
			}
			observer?.report("starting_runtime");
			const ref: WorkerUnitRef = {
				instanceId: input.instanceId,
				workerId: input.workerId,
				unitId: manifest.metadata.name,
				namespace: manifest.metadata.namespace,
			};
			watchPod(ref.unitId, ref.namespace ?? processNamespace, Object.values(input.env));
			return exitNotifier.wrapUnit(ref, unitKey(ref.namespace ?? processNamespace, ref.unitId), {
				replacementHandoff: "stop-before-replacement",
			});
		},
		async stop(ref: WorkerUnitRef, opts: StopWorkerOptions): Promise<void> {
			samplers.get(ref.instanceId)?.stop();
			samplers.delete(ref.instanceId);
			await deletePodAndWait(
				ref.unitId,
				ref.namespace ?? namespaceForProcess(ref.instanceId),
				Math.max(0, Math.ceil(opts.graceMs / 1000)),
			);
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
		async adopt(descriptor: WorkerUnitDescriptor, observer): Promise<WorkerUnit> {
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
			if (observer?.observe && pod.pvcName) {
				samplers.get(descriptor.instanceId)?.stop();
				const sampler = sampleKubernetesStartup(client, observer, podNamespace, pod.pvcName);
				sampler.attachPod({ name: ref.unitId, workerId: ref.workerId, instanceId: ref.instanceId });
				samplers.set(descriptor.instanceId, sampler);
			}
			watchPod(ref.unitId, podNamespace);
			return exitNotifier.wrapUnit(ref, unitKey(podNamespace, ref.unitId), {
				replacementHandoff: "stop-before-replacement",
			});
		},
	};

	const exporter = createHelperProcessStateExporter({
		volume,
		helperRelays,
		async launch(input) {
			const namespace = input.volume.namespace ?? namespaceForProcess(input.instanceId);
			const podName = kubernetesExportHelperPodName(input.instanceId, input.exportId);
			const manifest = buildKubernetesExportHelperPodManifest(
				{
					instanceId: input.instanceId,
					exportId: input.exportId,
					image: exporterImage,
					command: ["node", SESSION_TRANSFER_HELPER_ENTRY_PATH],
					env: exportHelperEnvironment({
						serverUrl: exporterServerUrl,
						exportId: input.exportId,
						credential: input.credential,
					}),
					volume: { ...input.volume, mountPath: SESSION_TRANSFER_HELPER_MOUNT_PATH },
				},
				{
					namespace,
					...(options.pod ?? {}),
					imagePullPolicy: options.exporterImagePullPolicy,
					...(serverCaFile
						? {
								serverCaConfigMap: {
									name: KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME,
									key: KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY,
									mountPath: KUBERNETES_WORKER_SERVER_CA_MOUNT_PATH,
								},
							}
						: {}),
				},
			);
			await client.createPod(manifest);
			const exit = new Promise<{ exitCode: number | null; reason?: string }>((resolve) => {
				client.onPodExit(podName, namespace, (info) =>
					resolve({ exitCode: info.exitCode, reason: info.reason }),
				);
			});
			return {
				wait: () => exit,
				remove: () => client.deletePod(podName, namespace, { gracePeriodSeconds: 0 }),
			};
		},
		async reconcileHelpers() {
			const namespaces = await client.listNamespaces(managedProcessNamespaceLabelSelector());
			for (const namespace of namespaces) {
				const helpers = await client.listPods(namespace.name, managedExportHelperLabelSelector());
				await Promise.all(
					helpers.map((helper) =>
						client.deletePod(helper.name, helper.namespace, { gracePeriodSeconds: 0 }),
					),
				);
			}
		},
	});

	return { runner, volume, exporter };
}

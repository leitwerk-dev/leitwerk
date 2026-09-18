import path from "node:path";
import type { DockerNetworkConfig } from "@leitwerk-dev/worker-protocol";
import type { IsolatedStartWorkerInput, VolumeRef, WorkerExitInfo } from "./types.js";
import {
	buildExportHelperLabels,
	buildProcessResourceLabels,
	buildWorkerUnitLabels,
	PROCESS_IMAGE_PULL_SECRET_COMPONENT_VALUE,
	PROCESS_NAMESPACE_COMPONENT_VALUE,
	PROCESS_SERVER_CA_COMPONENT_VALUE,
	PROCESS_VOLUME_COMPONENT_VALUE,
} from "./worker-labels.js";

/** @internal */
export interface KubernetesProcessVolumeSpec {
	/** @internal */
	storageClassName?: string;
	/** @internal */
	size: string;
	/** @internal */
	accessModes: string[];
	/** @internal */
	mountPath: string;
	/** @internal */
	namePrefix?: string;
}

/** @internal */
export interface KubernetesProcessNamespaceManifest {
	/** @internal */
	apiVersion: "v1";
	/** @internal */
	kind: "Namespace";
	/** @internal */
	metadata: {
		/** @internal */
		name: string;
		/** @internal */
		labels: Record<string, string>;
	};
}

/** @internal */
export interface KubernetesWorkerServerCaConfigMapSpec {
	/** @internal */
	name: string;
	/** @internal */
	key: string;
	/** @internal */
	mountPath: string;
}

/** @internal */
export interface KubernetesDockerPodSpecOptions {
	/** @internal */
	runtimeClassName: string;
	/** @internal */
	hostUsers: boolean;
	/** @internal */
	network?: DockerNetworkConfig;
}

/** @internal */
export interface KubernetesPodSpecOptions {
	/** @internal */
	namespace: string;
	/** @internal */
	workerServiceAccount?: string;
	/** @internal */
	imagePullSecrets?: string[];
	/** @internal */
	imagePullPolicy?: string;
	/** @internal */
	nodeSelector?: Record<string, string>;
	/** @internal */
	annotations?: Record<string, string>;
	/** @internal */
	tolerations?: unknown[];
	/** @internal */
	hostAliases?: Array<{
		/** @internal */
		ip: string;
		/** @internal */
		hostnames: string[];
	}>;
	/** @internal */
	serverCaConfigMap?: KubernetesWorkerServerCaConfigMapSpec;
	/** Trusted operator wiring used only when the process declares runtime.docker. @internal */
	docker?: KubernetesDockerPodSpecOptions;
}

/** @internal */
interface NamespacedManifest<Kind extends string> {
	/** @internal */
	apiVersion: "v1";
	/** @internal */
	kind: Kind;
	/** @internal */
	metadata: {
		/** @internal */
		name: string;
		/** @internal */
		namespace: string;
		/** @internal */
		labels: Record<string, string>;
	};
}

/** @internal */
export interface KubernetesPersistentVolumeClaimManifest
	extends NamespacedManifest<"PersistentVolumeClaim"> {
	/** @internal */
	spec: {
		/** @internal */
		accessModes: string[];
		/** @internal */
		resources: {
			/** @internal */
			requests: {
				/** @internal */
				storage: string;
			};
		};
		/** @internal */
		storageClassName?: string;
	};
}

/** @internal */
export interface KubernetesConfigMapManifest extends NamespacedManifest<"ConfigMap"> {
	/** @internal */
	data: Record<string, string>;
}

/** @internal */
export interface KubernetesDockerConfigJsonSecretManifest extends NamespacedManifest<"Secret"> {
	/** @internal */
	type: "kubernetes.io/dockerconfigjson";
	/** @internal */
	data: {
		/** @internal */
		".dockerconfigjson": string;
	};
}

/** @internal */
export interface KubernetesPodEventSummary {
	/** @internal */
	objectUid?: string;
	/** @internal */
	fieldPath?: string;
	/** @internal */
	firstTimestamp?: string;
	/** @internal */
	eventTime?: string;
	/** @internal */
	type?: string;
	/** @internal */
	reason?: string;
	/** @internal */
	message?: string;
	/** @internal */
	count?: number;
	/** @internal */
	lastTimestamp?: string;
}

/** @internal */
export interface KubernetesPodManifest extends NamespacedManifest<"Pod"> {
	/** @internal */
	metadata: NamespacedManifest<"Pod">["metadata"] & {
		/** @internal */
		annotations?: Record<string, string>;
	};
	/** @internal */
	spec: {
		/** @internal */
		restartPolicy: "Never";
		/** @internal */
		runtimeClassName?: string;
		/** @internal */
		hostUsers?: boolean;
		/** @internal */
		serviceAccountName?: string;
		/** @internal */
		nodeSelector?: KubernetesPodSpecOptions["nodeSelector"];
		/** @internal */
		tolerations?: KubernetesPodSpecOptions["tolerations"];
		/** @internal */
		hostAliases?: KubernetesPodSpecOptions["hostAliases"];
		/** @internal */
		imagePullSecrets?: Array<{
			/** @internal */
			name: string;
		}>;
		/** @internal */
		automountServiceAccountToken?: boolean;
		/** @internal */
		containers: Array<{
			/** @internal */
			name: string;
			/** @internal */
			image: string;
			/** @internal */
			command?: string[];
			/** @internal */
			imagePullPolicy?: string;
			/** @internal */
			env: Array<{
				/** @internal */
				name: string;
				/** @internal */
				value: string;
			}>;
			/** @internal */
			volumeMounts: Array<{
				/** @internal */
				name: string;
				/** @internal */
				mountPath: string;
				/** @internal */
				readOnly?: boolean;
				/** @internal */
				subPath?: string;
			}>;
			/** @internal */
			resources?: {
				/** @internal */
				requests?: Record<string, string>;
				/** @internal */
				limits?: Record<string, string>;
			};
		}>;
		/** @internal */
		volumes: Array<
			| {
					/** @internal */
					name: string;
					/** @internal */
					persistentVolumeClaim: {
						/** @internal */
						claimName: string;
					};
			  }
			| {
					/** @internal */
					name: string;
					/** @internal */
					configMap: {
						/** @internal */
						name: string;
						/** @internal */
						items: Array<{
							/** @internal */
							key: string;
							/** @internal */
							path: string;
						}>;
					};
			  }
		>;
	};
}

const DNS_LABEL_MAX = 63;
const WORKER_VOLUME_NAME = "process-state";
const WORKER_SERVER_CA_VOLUME_NAME = "server-ca";
export const KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME = "leitwerk-server-ca";
export const KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY = "server-ca.pem";
export const KUBERNETES_WORKER_SERVER_CA_MOUNT_PATH = "/leitwerk/server-ca";
export const KUBERNETES_WORKER_SERVER_CA_CERT_PATH = `${KUBERNETES_WORKER_SERVER_CA_MOUNT_PATH}/${KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY}`;

function safeKubernetesDnsName(value: string, maxLen = DNS_LABEL_MAX): string {
	const cleaned = sanitizeKubernetesNameSegment(value);
	const trimmed = cleaned.slice(0, maxLen).replace(/-+$/g, "");
	return trimmed.length > 0 ? trimmed : "x";
}

/** @internal */
export function sanitizeKubernetesNameSegment(value: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned.length > 0 ? cleaned : "x";
}

/** @internal */
export function kubernetesWorkerPodName(instanceId: string, workerId: string): string {
	return safeKubernetesDnsName(
		`leitwerk-worker-${sanitizeKubernetesNameSegment(instanceId)}-${sanitizeKubernetesNameSegment(workerId)}`,
	);
}

/** @internal */
export function kubernetesExportHelperPodName(instanceId: string, exportId: string): string {
	const exportSegment = sanitizeKubernetesNameSegment(exportId);
	const suffix = `-${exportSegment}`;
	const instancePrefix = safeKubernetesDnsName(
		`leitwerk-export-${sanitizeKubernetesNameSegment(instanceId)}`,
		Math.max(1, DNS_LABEL_MAX - suffix.length),
	);
	// Keep the random export id at the end of the name. Truncating the full
	// prefix would otherwise make long instance ids produce colliding helper
	// names for different exports.
	return safeKubernetesDnsName(`${instancePrefix}${suffix}`);
}

/** @internal */
export function kubernetesProcessPvcName(
	instanceId: string,
	namePrefix = "leitwerk-process-",
): string {
	return safeKubernetesDnsName(`${namePrefix}${sanitizeKubernetesNameSegment(instanceId)}`);
}

/** @internal */
export function kubernetesProcessNamespaceName(
	instanceId: string,
	processNamespacePrefix = "leitwerk-process-",
): string {
	return safeKubernetesDnsName(
		`${processNamespacePrefix}${sanitizeKubernetesNameSegment(instanceId)}`,
	);
}

/** @internal */
export function buildKubernetesProcessNamespaceManifest(args: {
	/** @internal */
	instanceId: string;
	/** @internal */
	processNamespacePrefix?: string;
	/** @internal */
	extraLabels?: Record<string, string>;
}): KubernetesProcessNamespaceManifest {
	return {
		apiVersion: "v1",
		kind: "Namespace",
		metadata: {
			name: kubernetesProcessNamespaceName(args.instanceId, args.processNamespacePrefix),
			labels: buildProcessResourceLabels(
				{ instanceId: args.instanceId, component: PROCESS_NAMESPACE_COMPONENT_VALUE },
				args.extraLabels,
			),
		},
	};
}

function processResourceMetadata(
	args: { instanceId: string; namespace: string; extraLabels?: Record<string, string> },
	name: string,
	component: Parameters<typeof buildProcessResourceLabels>[0]["component"],
): NamespacedManifest<string>["metadata"] {
	return {
		name,
		namespace: args.namespace,
		labels: buildProcessResourceLabels(
			{ instanceId: args.instanceId, component },
			args.extraLabels,
		),
	};
}

/** @internal */
export function buildKubernetesProcessPvcManifest(args: {
	/** @internal */
	instanceId: string;
	/** @internal */
	namespace: string;
	/** @internal */
	volume: KubernetesProcessVolumeSpec;
	/** @internal */
	extraLabels?: Record<string, string>;
}): KubernetesPersistentVolumeClaimManifest {
	const spec: KubernetesPersistentVolumeClaimManifest["spec"] = {
		accessModes: [...args.volume.accessModes],
		resources: { requests: { storage: args.volume.size } },
	};
	if (args.volume.storageClassName?.trim()) {
		spec.storageClassName = args.volume.storageClassName;
	}
	return {
		apiVersion: "v1",
		kind: "PersistentVolumeClaim",
		metadata: processResourceMetadata(
			args,
			kubernetesProcessPvcName(args.instanceId, args.volume.namePrefix),
			PROCESS_VOLUME_COMPONENT_VALUE,
		),
		spec,
	};
}

export function buildKubernetesServerCaConfigMapManifest(args: {
	instanceId: string;
	namespace: string;
	caPem: string;
	name?: string;
	key?: string;
	extraLabels?: Record<string, string>;
}): KubernetesConfigMapManifest {
	return {
		apiVersion: "v1",
		kind: "ConfigMap",
		metadata: processResourceMetadata(
			args,
			args.name ?? KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME,
			PROCESS_SERVER_CA_COMPONENT_VALUE,
		),
		data: { [args.key ?? KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_KEY]: args.caPem },
	};
}

export function buildKubernetesDockerConfigJsonSecretManifest(args: {
	instanceId: string;
	namespace: string;
	name: string;
	dockerConfigJson: string;
	extraLabels?: Record<string, string>;
}): KubernetesDockerConfigJsonSecretManifest {
	return {
		apiVersion: "v1",
		kind: "Secret",
		metadata: processResourceMetadata(args, args.name, PROCESS_IMAGE_PULL_SECRET_COMPONENT_VALUE),
		type: "kubernetes.io/dockerconfigjson",
		data: { ".dockerconfigjson": args.dockerConfigJson },
	};
}

function envList(env: Record<string, string>): Array<{ name: string; value: string }> {
	return Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => ({ name, value }));
}

function resources(
	input: IsolatedStartWorkerInput,
): KubernetesPodManifest["spec"]["containers"][number]["resources"] {
	const result: NonNullable<ReturnType<typeof resources>> = {};
	for (const [kind, values] of [
		["limits", { cpu: input.resources?.cpu, memory: input.resources?.memory }],
		["requests", input.resourceRequests],
	] as const) {
		const entries = Object.entries(values ?? {}).filter(([, value]) => value);
		if (entries.length) result[kind] = Object.fromEntries(entries);
	}
	return Object.keys(result).length ? result : undefined;
}

function podManifest(
	name: string,
	volume: VolumeRef,
	labels: Record<string, string>,
	options: KubernetesPodSpecOptions,
	container: KubernetesPodManifest["spec"]["containers"][number],
	spec: Partial<KubernetesPodManifest["spec"]> = {},
): KubernetesPodManifest {
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name,
			namespace: volume.namespace ?? options.namespace,
			labels,
			...(options.annotations && Object.keys(options.annotations).length > 0
				? { annotations: { ...options.annotations } }
				: {}),
		},
		spec: {
			restartPolicy: "Never",
			...(options.workerServiceAccount?.trim()
				? { serviceAccountName: options.workerServiceAccount }
				: {}),
			...(options.imagePullSecrets?.length
				? { imagePullSecrets: options.imagePullSecrets.map((name) => ({ name })) }
				: {}),
			...(options.nodeSelector && Object.keys(options.nodeSelector).length > 0
				? { nodeSelector: { ...options.nodeSelector } }
				: {}),
			...(options.tolerations?.length ? { tolerations: [...options.tolerations] } : {}),
			...(options.hostAliases?.length
				? {
						hostAliases: options.hostAliases.map(({ ip, hostnames }) => ({
							ip,
							hostnames: [...hostnames],
						})),
					}
				: {}),
			...spec,
			containers: [container],
			volumes: processStateVolumes(volume.id, options.serverCaConfigMap),
		},
	};
}

function processStateVolumes(
	claimName: string,
	ca: KubernetesWorkerServerCaConfigMapSpec | undefined,
): KubernetesPodManifest["spec"]["volumes"] {
	return [
		{ name: WORKER_VOLUME_NAME, persistentVolumeClaim: { claimName } },
		...(ca
			? [
					{
						name: WORKER_SERVER_CA_VOLUME_NAME,
						configMap: { name: ca.name, items: [{ key: ca.key, path: ca.key }] },
					},
				]
			: []),
	];
}

function processStateContainerConfig(
	env: Record<string, string>,
	mountPath: string,
	exportOnly: boolean,
	ca: KubernetesWorkerServerCaConfigMapSpec | undefined,
): Pick<KubernetesPodManifest["spec"]["containers"][number], "env" | "volumeMounts"> {
	return {
		env: envList(ca ? { ...env, NODE_EXTRA_CA_CERTS: `${ca.mountPath}/${ca.key}` } : env),
		volumeMounts: [
			...(exportOnly
				? ["workspace", "tree"].map((subPath) => ({
						name: WORKER_VOLUME_NAME,
						mountPath: path.posix.join(mountPath, subPath),
						subPath,
						readOnly: true,
					}))
				: [{ name: WORKER_VOLUME_NAME, mountPath }]),
			...(ca
				? [{ name: WORKER_SERVER_CA_VOLUME_NAME, mountPath: ca.mountPath, readOnly: true }]
				: []),
		],
	};
}

/** @internal */
export function buildKubernetesExportHelperPodManifest(
	input: {
		/** @internal */
		instanceId: string;
		/** @internal */
		exportId: string;
		/** @internal */
		image: string;
		/** @internal */
		command: string[];
		/** @internal */
		env: Record<string, string>;
		/** @internal */
		volume: VolumeRef;
	},
	options: KubernetesPodSpecOptions,
): KubernetesPodManifest {
	return podManifest(
		kubernetesExportHelperPodName(input.instanceId, input.exportId),
		input.volume,
		buildExportHelperLabels({ instanceId: input.instanceId, exportId: input.exportId }),
		options,
		{
			name: "session-export-helper",
			image: input.image,
			command: [...input.command],
			...processStateContainerConfig(
				input.env,
				input.volume.mountPath,
				true,
				options.serverCaConfigMap,
			),
			...(options.imagePullPolicy ? { imagePullPolicy: options.imagePullPolicy } : {}),
		},
		{ automountServiceAccountToken: false },
	);
}

/** @internal */
export function buildKubernetesWorkerPodManifest(
	input: IsolatedStartWorkerInput,
	options: KubernetesPodSpecOptions,
): KubernetesPodManifest {
	const volume = input.volume;
	const labels = buildWorkerUnitLabels({
		instanceId: input.instanceId,
		workerId: input.workerId,
		serverEpoch: input.serverEpoch,
	});
	const containerResources = resources(input);
	const ca = options.serverCaConfigMap;
	const trustedDockerEnv = input.docker
		? {
				...input.env,
				DOCKER_HOST: "unix:///var/run/docker.sock",
				LEITWERK_PRIVATE_DOCKER: "1",
				LEITWERK_PROCESS_VOLUME_MOUNT_PATH: volume.mountPath,
				...(options.docker?.network
					? { LEITWERK_DOCKER_NETWORK: JSON.stringify(options.docker.network) }
					: {}),
			}
		: input.env;
	const container: KubernetesPodManifest["spec"]["containers"][number] = {
		name: "worker",
		image: input.image.reference,
		...processStateContainerConfig(trustedDockerEnv, volume.mountPath, false, ca),
		...(options.imagePullPolicy ? { imagePullPolicy: options.imagePullPolicy } : {}),
		...(containerResources ? { resources: containerResources } : {}),
	};
	return podManifest(
		kubernetesWorkerPodName(input.instanceId, input.workerId),
		volume,
		labels,
		options,
		container,
		input.docker && options.docker
			? { runtimeClassName: options.docker.runtimeClassName, hostUsers: options.docker.hostUsers }
			: {},
	);
}

const KUBERNETES_DIAGNOSTIC_MAX_LENGTH = 2_048;

export function redactKubernetesDiagnostic(
	value: string,
	sensitiveValues: readonly string[] = [],
): string {
	let redacted = value;
	for (const sensitiveValue of sensitiveValues) {
		if (sensitiveValue.length >= 8) redacted = redacted.replaceAll(sensitiveValue, "<redacted>");
	}
	return redacted;
}

function boundedDiagnostic(value: string, sensitiveValues: readonly string[] = []): string {
	const redacted = redactKubernetesDiagnostic(value, sensitiveValues);
	return redacted.length <= KUBERNETES_DIAGNOSTIC_MAX_LENGTH
		? redacted
		: `${redacted.slice(0, KUBERNETES_DIAGNOSTIC_MAX_LENGTH - 1)}…`;
}

function formatPodEvent(
	event: KubernetesPodEventSummary,
	sensitiveValues: readonly string[],
): string | null {
	const pieces: string[] = [];
	if (event.type?.trim()) pieces.push(event.type.trim());
	if (event.reason?.trim()) pieces.push(event.reason.trim());
	if (event.count !== undefined && event.count > 1) pieces.push(`x${event.count}`);
	const prefix = pieces.join(" ");
	const message = event.message?.trim();
	if (!prefix && !message) return null;
	return boundedDiagnostic(
		message ? `${prefix ? `${prefix}: ` : ""}${message}` : prefix,
		sensitiveValues,
	);
}

/** @internal */
export function formatKubernetesPodDiagnostics(
	events: readonly KubernetesPodEventSummary[] | undefined,
	limit = 3,
	sensitiveValues: readonly string[] = [],
): string | undefined {
	const formatted = (events ?? [])
		.map((event) => formatPodEvent(event, sensitiveValues))
		.filter((entry): entry is string => entry !== null)
		.slice(0, limit);
	return formatted.length > 0
		? boundedDiagnostic(`Kubernetes events: ${formatted.join(" | ")}`, sensitiveValues)
		: undefined;
}

/** @internal */
export function mapKubernetesPodExit(args: {
	/** @internal */
	phase?: string;
	/** @internal */
	reason?: string;
	/** @internal */
	exitCode?: number | null;
	/** @internal */
	signal?: string | null;
	/** @internal */
	oomKilled?: boolean;
	/** @internal */
	terminationMessage?: string;
	/** @internal */
	events?: readonly KubernetesPodEventSummary[];
	/** @internal */
	sensitiveValues?: readonly string[];
}): WorkerExitInfo {
	const sensitiveValues = args.sensitiveValues ?? [];
	const baseReason = args.reason ?? args.phase;
	const startupDiagnostic = args.terminationMessage?.trim()
		? `Runtime startup: ${boundedDiagnostic(args.terminationMessage.trim(), sensitiveValues)}`
		: undefined;
	const diagnostics = formatKubernetesPodDiagnostics(args.events, 3, sensitiveValues);
	const reason = boundedDiagnostic(
		[baseReason, startupDiagnostic, diagnostics].filter(Boolean).join("; "),
		sensitiveValues,
	);
	return {
		exitCode: args.exitCode ?? null,
		signal: args.signal ?? null,
		...(args.oomKilled !== undefined ? { oomKilled: args.oomKilled } : {}),
		...(reason ? { reason } : {}),
	};
}

export function volumeRefFromPvc(args: {
	instanceId: string;
	pvcName: string;
	mountPath: string;
	namespace?: string;
}): VolumeRef {
	return {
		instanceId: args.instanceId,
		id: args.pvcName,
		mountPath: args.mountPath,
		...(args.namespace ? { namespace: args.namespace } : {}),
	};
}

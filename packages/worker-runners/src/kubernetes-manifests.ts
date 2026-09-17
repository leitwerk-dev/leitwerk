import path from "node:path";
import type { IsolatedStartWorkerInput, VolumeRef, WorkerExitInfo } from "./types.js";
import {
	buildExportHelperLabels,
	buildProcessResourceLabels,
	buildWorkerUnitLabels,
	EXPORT_HELPER_COMPONENT_VALUE,
	EXPORT_HELPER_LABEL_EXPORT_ID,
	PROCESS_IMAGE_PULL_SECRET_COMPONENT_VALUE,
	PROCESS_NAMESPACE_COMPONENT_VALUE,
	PROCESS_SERVER_CA_COMPONENT_VALUE,
	PROCESS_VOLUME_COMPONENT_VALUE,
	WORKER_LABEL_COMPONENT,
	WORKER_LABEL_COMPONENT_VALUE,
	WORKER_LABEL_INSTANCE_ID,
	WORKER_LABEL_MANAGED_BY,
	WORKER_LABEL_MANAGED_BY_VALUE,
	WORKER_LABEL_SERVER_EPOCH,
	WORKER_LABEL_WORKER_ID,
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
	/** Trusted operator wiring used only when the process declares runtime.docker. */
	/** @internal */
	docker?: KubernetesDockerPodSpecOptions;
}

/** @internal */
export interface KubernetesPersistentVolumeClaimManifest {
	/** @internal */
	apiVersion: "v1";
	/** @internal */
	kind: "PersistentVolumeClaim";
	/** @internal */
	metadata: {
		/** @internal */
		name: string;
		/** @internal */
		namespace: string;
		/** @internal */
		labels: Record<string, string>;
	};
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
export interface KubernetesConfigMapManifest {
	/** @internal */
	apiVersion: "v1";
	/** @internal */
	kind: "ConfigMap";
	/** @internal */
	metadata: {
		/** @internal */
		name: string;
		/** @internal */
		namespace: string;
		/** @internal */
		labels: Record<string, string>;
	};
	/** @internal */
	data: Record<string, string>;
}

/** @internal */
export interface KubernetesDockerConfigJsonSecretManifest {
	/** @internal */
	apiVersion: "v1";
	/** @internal */
	kind: "Secret";
	/** @internal */
	metadata: {
		/** @internal */
		name: string;
		/** @internal */
		namespace: string;
		/** @internal */
		labels: Record<string, string>;
	};
	/** @internal */
	type: "kubernetes.io/dockerconfigjson";
	/** @internal */
	data: {
		/** @internal */
		".dockerconfigjson": string;
	};
}

/** @internal */
export interface KubernetesValidatingAdmissionPolicyManifest {
	/** @internal */
	apiVersion: "admissionregistration.k8s.io/v1";
	/** @internal */
	kind: "ValidatingAdmissionPolicy";
	/** @internal */
	metadata: {
		/** @internal */
		name: string;
		/** @internal */
		labels?: Record<string, string>;
	};
	/** @internal */
	spec: {
		/** @internal */
		matchConditions?: Array<{
			/** @internal */
			name: string;
			/** @internal */
			expression: string;
		}>;
		/** @internal */
		matchConstraints: {
			/** @internal */
			resourceRules: Array<{
				/** @internal */
				apiGroups: string[];
				/** @internal */
				apiVersions: string[];
				/** @internal */
				operations: string[];
				/** @internal */
				resources: string[];
			}>;
		};
		/** @internal */
		validations: Array<{
			/** @internal */
			expression: string;
			/** @internal */
			message: string;
		}>;
	};
}

/** @internal */
export interface KubernetesValidatingAdmissionPolicyBindingManifest {
	/** @internal */
	apiVersion: "admissionregistration.k8s.io/v1";
	/** @internal */
	kind: "ValidatingAdmissionPolicyBinding";
	/** @internal */
	metadata: {
		/** @internal */
		name: string;
		/** @internal */
		labels?: Record<string, string>;
	};
	/** @internal */
	spec: {
		/** @internal */
		policyName: string;
		/** @internal */
		validationActions: string[];
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
export interface KubernetesPodManifest {
	/** @internal */
	apiVersion: "v1";
	/** @internal */
	kind: "Pod";
	/** @internal */
	metadata: {
		/** @internal */
		name: string;
		/** @internal */
		namespace: string;
		/** @internal */
		labels: Record<string, string>;
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
		nodeSelector?: Record<string, string>;
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
	const cleaned =
		value
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.replace(/^-+|-+$/g, "") || "x";
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
	const labels = buildProcessResourceLabels(
		{ instanceId: args.instanceId, component: PROCESS_VOLUME_COMPONENT_VALUE },
		args.extraLabels,
	);
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
		metadata: {
			name: kubernetesProcessPvcName(args.instanceId, args.volume.namePrefix),
			namespace: args.namespace,
			labels,
		},
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
	const labels = buildProcessResourceLabels(
		{ instanceId: args.instanceId, component: PROCESS_SERVER_CA_COMPONENT_VALUE },
		args.extraLabels,
	);
	return {
		apiVersion: "v1",
		kind: "ConfigMap",
		metadata: {
			name: args.name ?? KUBERNETES_WORKER_SERVER_CA_CONFIG_MAP_NAME,
			namespace: args.namespace,
			labels,
		},
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
		metadata: {
			name: args.name,
			namespace: args.namespace,
			labels: buildProcessResourceLabels(
				{
					instanceId: args.instanceId,
					component: PROCESS_IMAGE_PULL_SECRET_COMPONENT_VALUE,
				},
				args.extraLabels,
			),
		},
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
	const limits: Record<string, string> = {};
	if (input.resources?.cpu) limits.cpu = input.resources.cpu;
	if (input.resources?.memory) limits.memory = input.resources.memory;
	return Object.keys(limits).length > 0 ? { limits } : undefined;
}

function podMetadata(
	name: string,
	namespace: string,
	labels: Record<string, string>,
	options: KubernetesPodSpecOptions,
): KubernetesPodManifest["metadata"] {
	return {
		name,
		namespace,
		labels,
		...(options.annotations && Object.keys(options.annotations).length > 0
			? { annotations: { ...options.annotations } }
			: {}),
	};
}

function sharedPodSpec(options: KubernetesPodSpecOptions): Partial<KubernetesPodManifest["spec"]> {
	return {
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
	const ca = options.serverCaConfigMap;
	const namespace = input.volume.namespace ?? options.namespace;
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: podMetadata(
			kubernetesExportHelperPodName(input.instanceId, input.exportId),
			namespace,
			buildExportHelperLabels({ instanceId: input.instanceId, exportId: input.exportId }),
			options,
		),
		spec: {
			restartPolicy: "Never",
			automountServiceAccountToken: false,
			...sharedPodSpec(options),
			containers: [
				{
					name: "session-export-helper",
					image: input.image,
					command: [...input.command],
					...processStateContainerConfig(input.env, input.volume.mountPath, true, ca),
					...(options.imagePullPolicy ? { imagePullPolicy: options.imagePullPolicy } : {}),
				},
			],
			volumes: processStateVolumes(input.volume.id, ca),
		},
	};
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
	const caCertPath = ca ? `${ca.mountPath}/${ca.key}` : undefined;
	const trustedDockerEnv = input.docker
		? {
				...input.env,
				DOCKER_HOST: "unix:///var/run/docker.sock",
				LEITWERK_PRIVATE_DOCKER: "1",
				LEITWERK_PROCESS_VOLUME_MOUNT_PATH: volume.mountPath,
			}
		: input.env;
	const containerEnv = caCertPath
		? { ...trustedDockerEnv, NODE_EXTRA_CA_CERTS: caCertPath }
		: trustedDockerEnv;
	const volumeMounts: KubernetesPodManifest["spec"]["containers"][number]["volumeMounts"] = [
		{ name: WORKER_VOLUME_NAME, mountPath: volume.mountPath },
	];
	if (ca) {
		volumeMounts.push({
			name: WORKER_SERVER_CA_VOLUME_NAME,
			mountPath: ca.mountPath,
			readOnly: true,
		});
	}
	const container: KubernetesPodManifest["spec"]["containers"][number] = {
		name: "worker",
		image: input.image.reference,
		env: envList(containerEnv),
		volumeMounts,
		...(options.imagePullPolicy ? { imagePullPolicy: options.imagePullPolicy } : {}),
		...(containerResources ? { resources: containerResources } : {}),
	};
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: podMetadata(
			kubernetesWorkerPodName(input.instanceId, input.workerId),
			volume.namespace ?? options.namespace,
			labels,
			options,
		),
		spec: {
			restartPolicy: "Never",
			...sharedPodSpec(options),
			...(input.docker && options.docker
				? {
						runtimeClassName: options.docker.runtimeClassName,
						hostUsers: options.docker.hostUsers,
					}
				: {}),
			containers: [container],
			volumes: processStateVolumes(volume.id, ca),
		},
	};
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

interface AdmissionRule {
	/** "Namespace" = only-namespace, "!Namespace" = everything-but-namespace, or a specific kind */
	scope: string;
	condition: string;
	message: string;
}

function admissionObjectExpression(): string {
	return "(request.operation == 'DELETE' ? oldObject : object)";
}

function toAdmissionObjectCondition(condition: string): string {
	return condition.replaceAll("object.", `${admissionObjectExpression()}.`);
}

function toCelExpression(rule: AdmissionRule): string {
	const obj = admissionObjectExpression();
	const condition = toAdmissionObjectCondition(rule.condition);
	if (rule.scope === "Namespace") return `${obj}.kind != 'Namespace' || ${condition}`;
	if (rule.scope === "!Namespace") return `${obj}.kind == 'Namespace' || ${condition}`;
	return `${obj}.kind != '${rule.scope}' || ${condition}`;
}

/** @internal */
export function buildKubernetesAdmissionPolicyManifests(args: {
	/** @internal */
	name: string;
	/** @internal */
	serverNamespace: string;
	/** @internal */
	serverServiceAccountName: string;
	/** @internal */
	processNamespacePrefix: string;
	/** @internal */
	allowedWorkerServiceAccount?: string;
	/** @internal */
	allowedImagePullSecretNames?: string[];
	/** @internal */
	labels?: Record<string, string>;
}): {
	/** @internal */
	policy: KubernetesValidatingAdmissionPolicyManifest;
	/** @internal */
	binding: KubernetesValidatingAdmissionPolicyBindingManifest;
} {
	const p = args.processNamespacePrefix;
	const sa = args.allowedWorkerServiceAccount?.trim() || "leitwerk-worker";
	const M = WORKER_LABEL_MANAGED_BY;
	const MV = WORKER_LABEL_MANAGED_BY_VALUE;
	const C = WORKER_LABEL_COMPONENT;
	const NS = PROCESS_NAMESPACE_COMPONENT_VALUE;
	const PV = PROCESS_VOLUME_COMPONENT_VALUE;
	const CA = PROCESS_SERVER_CA_COMPONENT_VALUE;
	const IPS = PROCESS_IMAGE_PULL_SECRET_COMPONENT_VALUE;
	const CV = WORKER_LABEL_COMPONENT_VALUE;
	const EH = EXPORT_HELPER_COMPONENT_VALUE;
	const allowedSecretNames = (args.allowedImagePullSecretNames ?? []).map((name) => `'${name}'`);

	const rules: AdmissionRule[] = [
		{
			scope: "Namespace",
			condition: `object.metadata.name.startsWith('${p}')`,
			message: "leitwerk process namespaces must use the configured prefix",
		},
		{
			scope: "Namespace",
			condition: `object.metadata.labels['${M}'] == '${MV}'`,
			message: "leitwerk process namespaces must carry managed-by label",
		},
		{
			scope: "Namespace",
			condition: `object.metadata.labels['${C}'] == '${NS}'`,
			message: "leitwerk process namespaces must carry process-namespace component label",
		},
		{
			scope: "!Namespace",
			condition: `object.metadata.namespace.startsWith('${p}')`,
			message: "leitwerk process resources must be created in process namespaces",
		},
		{
			scope: "!Namespace",
			condition: `object.metadata.labels['${M}'] == '${MV}'`,
			message: "leitwerk process resources must carry managed-by label",
		},
		{
			scope: "PersistentVolumeClaim",
			condition: `object.metadata.labels['${C}'] == '${PV}'`,
			message: "leitwerk PVCs must carry process-volume component label",
		},
		{
			scope: "ConfigMap",
			condition: `object.metadata.labels['${C}'] == '${CA}'`,
			message: "leitwerk server CA ConfigMaps must carry server-ca component label",
		},
		{
			scope: "Pod",
			condition: `object.metadata.labels['${C}'] in ['${CV}', '${EH}']`,
			message: "leitwerk pods must carry worker or session-export-helper component label",
		},
		{
			scope: "ServiceAccount",
			condition: `object.metadata.labels['${C}'] == 'worker-service-account'`,
			message: "leitwerk worker ServiceAccounts must carry worker-service-account component label",
		},
		{
			scope: "Secret",
			condition:
				allowedSecretNames.length > 0
					? `object.metadata.name in [${allowedSecretNames.join(", ")}]`
					: "false",
			message: "leitwerk image-pull Secrets must use a configured target name",
		},
		{
			scope: "Secret",
			condition: `object.metadata.labels['${C}'] == '${IPS}'`,
			message: "leitwerk image-pull Secrets must carry image-pull-secret component label",
		},
		{
			scope: "Secret",
			condition: "object.type == 'kubernetes.io/dockerconfigjson'",
			message: "leitwerk image-pull Secrets must use dockerconfigjson type",
		},
		{
			scope: "Secret",
			condition: "object.data.size() == 1 && '.dockerconfigjson' in object.data",
			message: "leitwerk image-pull Secrets may contain only .dockerconfigjson",
		},
		{
			scope: "Pod",
			condition: `object.spec.serviceAccountName == '${sa}'`,
			message: "leitwerk worker pods must use the configured worker ServiceAccount",
		},
		{
			scope: "Pod",
			condition: `'${WORKER_LABEL_INSTANCE_ID}' in object.metadata.labels`,
			message: "leitwerk worker pods must carry instance-id label",
		},
		{
			scope: "Pod",
			condition: `object.metadata.labels['${C}'] != '${CV}' || '${WORKER_LABEL_WORKER_ID}' in object.metadata.labels`,
			message: "leitwerk worker pods must carry worker-id label",
		},
		{
			scope: "Pod",
			condition: `object.metadata.labels['${C}'] != '${CV}' || '${WORKER_LABEL_SERVER_EPOCH}' in object.metadata.labels`,
			message: "leitwerk worker pods must carry server-epoch label",
		},
		{
			scope: "Pod",
			condition: `object.metadata.labels['${C}'] != '${EH}' || '${EXPORT_HELPER_LABEL_EXPORT_ID}' in object.metadata.labels`,
			message: "leitwerk session export helper pods must carry export-id label",
		},
	];

	const labels = args.labels;
	const meta = { name: args.name, ...(labels ? { labels: { ...labels } } : {}) };
	return {
		policy: {
			apiVersion: "admissionregistration.k8s.io/v1",
			kind: "ValidatingAdmissionPolicy",
			metadata: meta,
			spec: {
				matchConditions: [
					{
						name: "leitwerk-server-service-account",
						expression: `request.userInfo.username == 'system:serviceaccount:${args.serverNamespace}:${args.serverServiceAccountName}'`,
					},
				],
				matchConstraints: {
					resourceRules: [
						{
							apiGroups: [""],
							apiVersions: ["v1"],
							operations: ["CREATE", "UPDATE", "DELETE"],
							resources: [
								"namespaces",
								"pods",
								"persistentvolumeclaims",
								"serviceaccounts",
								"configmaps",
								"secrets",
							],
						},
					],
				},
				validations: rules.map((r) => ({ expression: toCelExpression(r), message: r.message })),
			},
		},
		binding: {
			apiVersion: "admissionregistration.k8s.io/v1",
			kind: "ValidatingAdmissionPolicyBinding",
			metadata: meta,
			spec: { policyName: args.name, validationActions: ["Deny"] },
		},
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

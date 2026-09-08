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

export interface KubernetesProcessVolumeSpec {
	storageClassName?: string;
	size: string;
	accessModes: string[];
	mountPath: string;
	namePrefix?: string;
}

export interface KubernetesProcessNamespaceManifest {
	apiVersion: "v1";
	kind: "Namespace";
	metadata: { name: string; labels: Record<string, string> };
}

export interface KubernetesWorkerServerCaConfigMapSpec {
	name: string;
	key: string;
	mountPath: string;
}

export interface KubernetesDockerPodSpecOptions {
	runtimeClassName: string;
	hostUsers: boolean;
}

export interface KubernetesPodSpecOptions {
	namespace: string;
	workerServiceAccount?: string;
	imagePullSecrets?: string[];
	imagePullPolicy?: string;
	nodeSelector?: Record<string, string>;
	annotations?: Record<string, string>;
	tolerations?: unknown[];
	hostAliases?: Array<{ ip: string; hostnames: string[] }>;
	serverCaConfigMap?: KubernetesWorkerServerCaConfigMapSpec;
	/** Trusted operator wiring used only when the process declares runtime.docker. */
	docker?: KubernetesDockerPodSpecOptions;
}

export interface KubernetesPersistentVolumeClaimManifest {
	apiVersion: "v1";
	kind: "PersistentVolumeClaim";
	metadata: { name: string; namespace: string; labels: Record<string, string> };
	spec: {
		accessModes: string[];
		resources: { requests: { storage: string } };
		storageClassName?: string;
	};
}

export interface KubernetesConfigMapManifest {
	apiVersion: "v1";
	kind: "ConfigMap";
	metadata: { name: string; namespace: string; labels: Record<string, string> };
	data: Record<string, string>;
}

export interface KubernetesDockerConfigJsonSecretManifest {
	apiVersion: "v1";
	kind: "Secret";
	metadata: { name: string; namespace: string; labels: Record<string, string> };
	type: "kubernetes.io/dockerconfigjson";
	data: { ".dockerconfigjson": string };
}

export interface KubernetesValidatingAdmissionPolicyManifest {
	apiVersion: "admissionregistration.k8s.io/v1";
	kind: "ValidatingAdmissionPolicy";
	metadata: { name: string; labels?: Record<string, string> };
	spec: {
		matchConditions?: Array<{ name: string; expression: string }>;
		matchConstraints: {
			resourceRules: Array<{
				apiGroups: string[];
				apiVersions: string[];
				operations: string[];
				resources: string[];
			}>;
		};
		validations: Array<{ expression: string; message: string }>;
	};
}

export interface KubernetesValidatingAdmissionPolicyBindingManifest {
	apiVersion: "admissionregistration.k8s.io/v1";
	kind: "ValidatingAdmissionPolicyBinding";
	metadata: { name: string; labels?: Record<string, string> };
	spec: {
		policyName: string;
		validationActions: string[];
	};
}

export interface KubernetesPodEventSummary {
	type?: string;
	reason?: string;
	message?: string;
	count?: number;
	lastTimestamp?: string;
}

export interface KubernetesPodManifest {
	apiVersion: "v1";
	kind: "Pod";
	metadata: {
		name: string;
		namespace: string;
		labels: Record<string, string>;
		annotations?: Record<string, string>;
	};
	spec: {
		restartPolicy: "Never";
		runtimeClassName?: string;
		hostUsers?: boolean;
		serviceAccountName?: string;
		nodeSelector?: Record<string, string>;
		tolerations?: unknown[];
		hostAliases?: Array<{ ip: string; hostnames: string[] }>;
		imagePullSecrets?: Array<{ name: string }>;
		automountServiceAccountToken?: boolean;
		containers: Array<{
			name: string;
			image: string;
			command?: string[];
			imagePullPolicy?: string;
			env: Array<{ name: string; value: string }>;
			volumeMounts: Array<{
				name: string;
				mountPath: string;
				readOnly?: boolean;
				subPath?: string;
			}>;
			resources?: {
				requests?: Record<string, string>;
				limits?: Record<string, string>;
			};
		}>;
		volumes: Array<
			| { name: string; persistentVolumeClaim: { claimName: string } }
			| { name: string; configMap: { name: string; items: Array<{ key: string; path: string }> } }
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

export function sanitizeKubernetesNameSegment(value: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned.length > 0 ? cleaned : "x";
}

export function kubernetesWorkerPodName(instanceId: string, workerId: string): string {
	return safeKubernetesDnsName(
		`leitwerk-worker-${sanitizeKubernetesNameSegment(instanceId)}-${sanitizeKubernetesNameSegment(workerId)}`,
	);
}

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

export function kubernetesProcessPvcName(
	instanceId: string,
	namePrefix = "leitwerk-process-",
): string {
	return safeKubernetesDnsName(`${namePrefix}${sanitizeKubernetesNameSegment(instanceId)}`);
}

export function kubernetesProcessNamespaceName(
	instanceId: string,
	processNamespacePrefix = "leitwerk-process-",
): string {
	return safeKubernetesDnsName(
		`${processNamespacePrefix}${sanitizeKubernetesNameSegment(instanceId)}`,
	);
}

export function buildKubernetesProcessNamespaceManifest(args: {
	instanceId: string;
	processNamespacePrefix?: string;
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

export function buildKubernetesProcessPvcManifest(args: {
	instanceId: string;
	namespace: string;
	volume: KubernetesProcessVolumeSpec;
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

export function buildKubernetesExportHelperPodManifest(
	input: {
		instanceId: string;
		exportId: string;
		image: string;
		command: string[];
		env: Record<string, string>;
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

export function mapKubernetesPodExit(args: {
	phase?: string;
	reason?: string;
	exitCode?: number | null;
	signal?: string | null;
	oomKilled?: boolean;
	terminationMessage?: string;
	events?: readonly KubernetesPodEventSummary[];
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

export function buildKubernetesAdmissionPolicyManifests(args: {
	name: string;
	serverNamespace: string;
	serverServiceAccountName: string;
	processNamespacePrefix: string;
	allowedWorkerServiceAccount?: string;
	allowedImagePullSecretNames?: string[];
	labels?: Record<string, string>;
}): {
	policy: KubernetesValidatingAdmissionPolicyManifest;
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

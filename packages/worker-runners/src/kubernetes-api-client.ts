import {
	type KubernetesConfigMapManifest,
	type KubernetesDockerConfigJsonSecretManifest,
	type KubernetesPersistentVolumeClaimManifest,
	type KubernetesPodEventSummary,
	type KubernetesPodManifest,
	type KubernetesProcessNamespaceManifest,
	mapKubernetesPodExit,
} from "./kubernetes-manifests.js";
import type { VolumePoolApi } from "./kubernetes-volume-pool-api.js";
import type { WorkerExitInfo } from "./types.js";

/** @internal */
export interface KubernetesPodSummary {
	/** @internal */
	uid?: string;
	/** @internal */
	createdAt?: string;
	/** @internal */
	scheduledAt?: string;
	/** @internal */
	containerStartedAt?: string;
	/** @internal */
	node?: string;
	/** @internal */
	imageId?: string;
	/** @internal */
	pvcName?: string;
	/** @internal */
	resources?: {
		/** @internal */
		cpu?: string;
		/** @internal */
		memory?: string;
	};
	/** @internal */
	name: string;
	/** @internal */
	namespace: string;
	/** @internal */
	labels: Record<string, string>;
	/** @internal */
	phase?: string;
}

/** @internal */
export interface KubernetesNamespaceSummary {
	/** @internal */
	name: string;
	/** @internal */
	labels: Record<string, string>;
}

/** @internal */
export interface KubernetesPodDiagnosticOptions {
	/** @internal */
	sensitiveValues?: readonly string[];
}

/** @internal */
export interface KubernetesApiRequestOptions {
	/** @internal */
	signal?: AbortSignal;
}

/** @internal */
export interface KubernetesPvcSummary {
	/** @internal */
	uid?: string;
	/** @internal */
	phase?: string;
	/** @internal */
	storageClass?: string;
}
/** @internal */
export interface KubernetesApiClient {
	/** @internal */
	volumePool?: VolumePoolApi;
	/** @internal */
	getPersistentVolumeClaim?(
		name: string,
		namespace: string,
		options?: KubernetesApiRequestOptions,
	): Promise<KubernetesPvcSummary | null>;
	/** @internal */
	ensureNamespace(manifest: KubernetesProcessNamespaceManifest): Promise<void>;
	/** @internal */
	deleteNamespace(name: string): Promise<void>;
	/** @internal */
	listNamespaces(labels: Record<string, string>): Promise<KubernetesNamespaceSummary[]>;
	/** @internal */
	ensureServiceAccount(
		name: string,
		namespace: string,
		labels: Record<string, string>,
	): Promise<void>;
	/** @internal */
	ensureConfigMap(manifest: KubernetesConfigMapManifest): Promise<void>;
	/** @internal */
	getDockerConfigJsonSecret(name: string, namespace: string): Promise<string>;
	/** @internal */
	ensureDockerConfigJsonSecret(manifest: KubernetesDockerConfigJsonSecretManifest): Promise<void>;
	/** @internal */
	ensurePersistentVolumeClaim(manifest: KubernetesPersistentVolumeClaimManifest): Promise<void>;
	/** @internal */
	deletePersistentVolumeClaim(name: string, namespace: string): Promise<void>;
	/** @internal */
	createPod(manifest: KubernetesPodManifest): Promise<void>;
	/** @internal */
	deletePod(
		name: string,
		namespace: string,
		options: KubernetesApiRequestOptions & {
			/** @internal */
			gracePeriodSeconds: number;
		},
	): Promise<void>;
	/** @internal */
	getPod(
		name: string,
		namespace: string,
		options?: KubernetesApiRequestOptions,
	): Promise<KubernetesPodSummary | null>;
	/** @internal */
	listPodEvents(
		name: string,
		namespace: string,
		options?: KubernetesApiRequestOptions,
	): Promise<KubernetesPodEventSummary[]>;
	/** @internal */
	listPods(namespace: string, labels: Record<string, string>): Promise<KubernetesPodSummary[]>;
	/** @internal */
	onPodExit(
		name: string,
		namespace: string,
		listener: (info: WorkerExitInfo) => void,
		options?: KubernetesPodDiagnosticOptions,
	): () => void;
}

function labelsMatch(actual: Record<string, string>, selector: Record<string, string>): boolean {
	return Object.entries(selector).every(([key, value]) => actual[key] === value);
}

/** @internal */
export class FakeKubernetesApiClient implements KubernetesApiClient {
	/** @internal */
	readonly namespaces = new Map<string, KubernetesProcessNamespaceManifest>();
	/** @internal */
	readonly configMaps = new Map<string, KubernetesConfigMapManifest>();
	/** @internal */
	readonly secrets = new Map<string, KubernetesDockerConfigJsonSecretManifest>();
	/** @internal */
	readonly pvcs = new Map<string, KubernetesPersistentVolumeClaimManifest>();
	/** @internal */
	readonly pods = new Map<
		string,
		KubernetesPodManifest & {
			/** @internal */
			phase?: string;
		}
	>();
	/** @internal */
	readonly deletedNamespaces: string[] = [];
	/** @internal */
	readonly deletedPods: Array<{
		/** @internal */
		name: string;
		/** @internal */
		namespace: string;
		/** @internal */
		gracePeriodSeconds: number;
	}> = [];
	/** @internal */
	readonly deletedPvcs: Array<{
		/** @internal */
		name: string;
		/** @internal */
		namespace: string;
	}> = [];
	private readonly listeners = new Map<string, Array<(info: WorkerExitInfo) => void>>();
	private readonly podEvents = new Map<string, KubernetesPodEventSummary[]>();

	/** @internal */
	async ensureNamespace(manifest: KubernetesProcessNamespaceManifest): Promise<void> {
		this.namespaces.set(manifest.metadata.name, structuredClone(manifest));
	}

	/** @internal */
	async deleteNamespace(name: string): Promise<void> {
		this.deletedNamespaces.push(name);
		this.namespaces.delete(name);
		for (const resources of [this.configMaps, this.secrets, this.pvcs, this.pods]) {
			for (const resourceKey of resources.keys()) {
				if (resourceKey.startsWith(`${name}/`)) resources.delete(resourceKey);
			}
		}
	}

	/** @internal */
	async listNamespaces(labels: Record<string, string>): Promise<KubernetesNamespaceSummary[]> {
		const summaries: KubernetesNamespaceSummary[] = [];
		for (const namespace of this.namespaces.values()) {
			if (!labelsMatch(namespace.metadata.labels, labels)) continue;
			summaries.push({
				name: namespace.metadata.name,
				labels: { ...namespace.metadata.labels },
			});
		}
		return summaries;
	}

	/** @internal */
	async ensureServiceAccount(
		_name: string,
		_namespace: string,
		_labels: Record<string, string>,
	): Promise<void> {
		// The fake client does not model ServiceAccount objects separately; ensure is idempotent.
	}

	/** @internal */
	async ensureConfigMap(manifest: KubernetesConfigMapManifest): Promise<void> {
		this.configMaps.set(
			key(manifest.metadata.namespace, manifest.metadata.name),
			structuredClone(manifest),
		);
	}

	/** @internal */
	async getDockerConfigJsonSecret(name: string, namespace: string): Promise<string> {
		const secret = this.secrets.get(key(namespace, name));
		if (!secret) throw new Error(`Kubernetes image-pull Secret ${namespace}/${name} was not found`);
		return secret.data[".dockerconfigjson"];
	}

	/** @internal */
	async ensureDockerConfigJsonSecret(
		manifest: KubernetesDockerConfigJsonSecretManifest,
	): Promise<void> {
		this.secrets.set(
			key(manifest.metadata.namespace, manifest.metadata.name),
			structuredClone(manifest),
		);
	}

	/** @internal */
	async ensurePersistentVolumeClaim(
		manifest: KubernetesPersistentVolumeClaimManifest,
	): Promise<void> {
		const pvcKey = key(manifest.metadata.namespace, manifest.metadata.name);
		if (!this.pvcs.has(pvcKey)) this.pvcs.set(pvcKey, structuredClone(manifest));
	}

	/** @internal */
	async deletePersistentVolumeClaim(name: string, namespace: string): Promise<void> {
		this.deletedPvcs.push({ name, namespace });
		this.pvcs.delete(key(namespace, name));
	}

	/** @internal */
	async createPod(manifest: KubernetesPodManifest): Promise<void> {
		this.pods.set(key(manifest.metadata.namespace, manifest.metadata.name), {
			...structuredClone(manifest),
			phase: "Running",
		});
	}

	/** @internal */
	async deletePod(
		name: string,
		namespace: string,
		options: KubernetesApiRequestOptions & {
			/** @internal */
			gracePeriodSeconds: number;
		},
	): Promise<void> {
		options.signal?.throwIfAborted();
		this.deletedPods.push({ name, namespace, gracePeriodSeconds: options.gracePeriodSeconds });
		this.pods.delete(key(namespace, name));
		this.emit(name, namespace, { exitCode: 0, signal: null, reason: "Deleted" });
	}

	/** @internal */
	async getPod(
		name: string,
		namespace: string,
		options?: KubernetesApiRequestOptions,
	): Promise<KubernetesPodSummary | null> {
		options?.signal?.throwIfAborted();
		const pod = this.pods.get(key(namespace, name));
		return pod
			? {
					name: pod.metadata.name,
					namespace: pod.metadata.namespace,
					labels: { ...pod.metadata.labels },
					phase: pod.phase,
				}
			: null;
	}

	/** @internal */
	async listPodEvents(
		name: string,
		namespace: string,
		options?: KubernetesApiRequestOptions,
	): Promise<KubernetesPodEventSummary[]> {
		options?.signal?.throwIfAborted();
		return (this.podEvents.get(key(namespace, name)) ?? []).map((event) => ({ ...event }));
	}

	/** @internal */
	async listPods(
		namespace: string,
		labels: Record<string, string>,
	): Promise<KubernetesPodSummary[]> {
		const summaries: KubernetesPodSummary[] = [];
		for (const pod of this.pods.values()) {
			if (pod.metadata.namespace !== namespace) continue;
			if (!labelsMatch(pod.metadata.labels, labels)) continue;
			summaries.push({
				name: pod.metadata.name,
				namespace: pod.metadata.namespace,
				labels: { ...pod.metadata.labels },
				phase: pod.phase,
			});
		}
		return summaries;
	}

	/** @internal */
	onPodExit(
		name: string,
		namespace: string,
		listener: (info: WorkerExitInfo) => void,
		_options?: KubernetesPodDiagnosticOptions,
	): () => void {
		const k = key(namespace, name);
		const listeners = this.listeners.get(k) ?? [];
		listeners.push(listener);
		this.listeners.set(k, listeners);
		return () => {
			const existing = this.listeners.get(k) ?? [];
			this.listeners.set(
				k,
				existing.filter((entry) => entry !== listener),
			);
		};
	}

	/** @internal */
	recordPodEvent(name: string, namespace: string, event: KubernetesPodEventSummary): void {
		const k = key(namespace, name);
		const events = this.podEvents.get(k) ?? [];
		events.push({ ...event });
		this.podEvents.set(k, events);
	}

	/** @internal */
	simulatePodFailure(name: string, namespace: string, info: WorkerExitInfo): void {
		const pod = this.pods.get(key(namespace, name));
		if (pod) pod.phase = "Failed";
		const events = this.podEvents.get(key(namespace, name));
		this.emit(
			name,
			namespace,
			mapKubernetesPodExit({
				phase: "Failed",
				reason: info.reason,
				exitCode: info.exitCode,
				signal: info.signal,
				oomKilled: info.oomKilled,
				events,
			}),
		);
	}

	private emit(name: string, namespace: string, info: WorkerExitInfo): void {
		const k = key(namespace, name);
		const listeners = this.listeners.get(k) ?? [];
		this.listeners.delete(k);
		for (const listener of listeners) listener(info);
	}
}

function key(namespace: string, name: string): string {
	return `${namespace}/${name}`;
}

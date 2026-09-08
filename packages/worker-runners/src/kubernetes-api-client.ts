import {
	type KubernetesConfigMapManifest,
	type KubernetesDockerConfigJsonSecretManifest,
	type KubernetesPersistentVolumeClaimManifest,
	type KubernetesPodEventSummary,
	type KubernetesPodManifest,
	type KubernetesProcessNamespaceManifest,
	mapKubernetesPodExit,
} from "./kubernetes-manifests.js";
import type { WorkerExitInfo } from "./types.js";

export interface KubernetesPodSummary {
	name: string;
	namespace: string;
	labels: Record<string, string>;
	phase?: string;
}

export interface KubernetesNamespaceSummary {
	name: string;
	labels: Record<string, string>;
}

export interface KubernetesPodDiagnosticOptions {
	sensitiveValues?: readonly string[];
}

export interface KubernetesApiRequestOptions {
	signal?: AbortSignal;
}

export interface KubernetesApiClient {
	ensureNamespace(manifest: KubernetesProcessNamespaceManifest): Promise<void>;
	deleteNamespace(name: string): Promise<void>;
	listNamespaces(labels: Record<string, string>): Promise<KubernetesNamespaceSummary[]>;
	ensureServiceAccount(
		name: string,
		namespace: string,
		labels: Record<string, string>,
	): Promise<void>;
	ensureConfigMap(manifest: KubernetesConfigMapManifest): Promise<void>;
	getDockerConfigJsonSecret(name: string, namespace: string): Promise<string>;
	ensureDockerConfigJsonSecret(manifest: KubernetesDockerConfigJsonSecretManifest): Promise<void>;
	ensurePersistentVolumeClaim(manifest: KubernetesPersistentVolumeClaimManifest): Promise<void>;
	deletePersistentVolumeClaim(name: string, namespace: string): Promise<void>;
	createPod(manifest: KubernetesPodManifest): Promise<void>;
	deletePod(
		name: string,
		namespace: string,
		options: KubernetesApiRequestOptions & { gracePeriodSeconds: number },
	): Promise<void>;
	getPod(
		name: string,
		namespace: string,
		options?: KubernetesApiRequestOptions,
	): Promise<KubernetesPodSummary | null>;
	listPodEvents(name: string, namespace: string): Promise<KubernetesPodEventSummary[]>;
	listPods(namespace: string, labels: Record<string, string>): Promise<KubernetesPodSummary[]>;
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

export class FakeKubernetesApiClient implements KubernetesApiClient {
	readonly namespaces = new Map<string, KubernetesProcessNamespaceManifest>();
	readonly configMaps = new Map<string, KubernetesConfigMapManifest>();
	readonly secrets = new Map<string, KubernetesDockerConfigJsonSecretManifest>();
	readonly pvcs = new Map<string, KubernetesPersistentVolumeClaimManifest>();
	readonly pods = new Map<string, KubernetesPodManifest & { phase?: string }>();
	readonly deletedNamespaces: string[] = [];
	readonly deletedPods: Array<{ name: string; namespace: string; gracePeriodSeconds: number }> = [];
	readonly deletedPvcs: Array<{ name: string; namespace: string }> = [];
	private readonly listeners = new Map<string, Array<(info: WorkerExitInfo) => void>>();
	private readonly podEvents = new Map<string, KubernetesPodEventSummary[]>();

	async ensureNamespace(manifest: KubernetesProcessNamespaceManifest): Promise<void> {
		this.namespaces.set(manifest.metadata.name, structuredClone(manifest));
	}

	async deleteNamespace(name: string): Promise<void> {
		this.deletedNamespaces.push(name);
		this.namespaces.delete(name);
		for (const resources of [this.configMaps, this.secrets, this.pvcs, this.pods]) {
			for (const resourceKey of resources.keys()) {
				if (resourceKey.startsWith(`${name}/`)) resources.delete(resourceKey);
			}
		}
	}

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

	async ensureServiceAccount(
		_name: string,
		_namespace: string,
		_labels: Record<string, string>,
	): Promise<void> {
		// The fake client does not model ServiceAccount objects separately; ensure is idempotent.
	}

	async ensureConfigMap(manifest: KubernetesConfigMapManifest): Promise<void> {
		this.configMaps.set(
			key(manifest.metadata.namespace, manifest.metadata.name),
			structuredClone(manifest),
		);
	}

	async getDockerConfigJsonSecret(name: string, namespace: string): Promise<string> {
		const secret = this.secrets.get(key(namespace, name));
		if (!secret) throw new Error(`Kubernetes image-pull Secret ${namespace}/${name} was not found`);
		return secret.data[".dockerconfigjson"];
	}

	async ensureDockerConfigJsonSecret(
		manifest: KubernetesDockerConfigJsonSecretManifest,
	): Promise<void> {
		this.secrets.set(
			key(manifest.metadata.namespace, manifest.metadata.name),
			structuredClone(manifest),
		);
	}

	async ensurePersistentVolumeClaim(
		manifest: KubernetesPersistentVolumeClaimManifest,
	): Promise<void> {
		this.pvcs.set(
			key(manifest.metadata.namespace, manifest.metadata.name),
			structuredClone(manifest),
		);
	}

	async deletePersistentVolumeClaim(name: string, namespace: string): Promise<void> {
		this.deletedPvcs.push({ name, namespace });
		this.pvcs.delete(key(namespace, name));
	}

	async createPod(manifest: KubernetesPodManifest): Promise<void> {
		this.pods.set(key(manifest.metadata.namespace, manifest.metadata.name), {
			...structuredClone(manifest),
			phase: "Running",
		});
	}

	async deletePod(
		name: string,
		namespace: string,
		options: KubernetesApiRequestOptions & { gracePeriodSeconds: number },
	): Promise<void> {
		options.signal?.throwIfAborted();
		this.deletedPods.push({ name, namespace, gracePeriodSeconds: options.gracePeriodSeconds });
		this.pods.delete(key(namespace, name));
		this.emit(name, namespace, { exitCode: 0, signal: null, reason: "Deleted" });
	}

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

	async listPodEvents(name: string, namespace: string): Promise<KubernetesPodEventSummary[]> {
		return (this.podEvents.get(key(namespace, name)) ?? []).map((event) => ({ ...event }));
	}

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

	recordPodEvent(name: string, namespace: string, event: KubernetesPodEventSummary): void {
		const k = key(namespace, name);
		const events = this.podEvents.get(k) ?? [];
		events.push({ ...event });
		this.podEvents.set(k, events);
	}

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

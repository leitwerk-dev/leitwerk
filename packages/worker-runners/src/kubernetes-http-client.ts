import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type {
	KubernetesApiClient,
	KubernetesNamespaceSummary,
	KubernetesPodSummary,
} from "./kubernetes-api-client.js";
import {
	type KubernetesConfigMapManifest,
	type KubernetesDockerConfigJsonSecretManifest,
	type KubernetesPersistentVolumeClaimManifest,
	type KubernetesPodManifest,
	type KubernetesProcessNamespaceManifest,
	mapKubernetesPodExit,
} from "./kubernetes-manifests.js";
import type { WorkerExitInfo } from "./types.js";

const IN_CLUSTER_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const IN_CLUSTER_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const DEFAULT_IN_CLUSTER_API = "https://kubernetes.default.svc";

interface KubernetesListResponse<T> {
	items?: T[];
}

interface KubernetesObjectResponse {
	metadata?: {
		name?: string;
		namespace?: string;
		labels?: Record<string, string>;
	};
	status?: {
		phase?: string;
		reason?: string;
		containerStatuses?: Array<{
			state?: {
				terminated?: {
					exitCode?: number;
					reason?: string;
					signal?: number;
				};
			};
			lastState?: {
				terminated?: {
					exitCode?: number;
					reason?: string;
					signal?: number;
				};
			};
		}>;
	};
	type?: string;
	data?: Record<string, string>;
}

export interface KubernetesHttpApiClientOptions {
	apiServerUrl?: string;
	bearerToken?: string;
	caFile?: string;
	pollIntervalMs?: number;
}

export function createInClusterKubernetesApiClient(
	options: KubernetesHttpApiClientOptions = {},
): KubernetesApiClient {
	const token = options.bearerToken ?? readFileSync(IN_CLUSTER_TOKEN_PATH, "utf8").trim();
	const ca = readFileSync(options.caFile ?? IN_CLUSTER_CA_PATH);
	return createKubernetesHttpApiClient({
		apiServerUrl: options.apiServerUrl ?? DEFAULT_IN_CLUSTER_API,
		bearerToken: token,
		ca,
		pollIntervalMs: options.pollIntervalMs,
	});
}

export function createKubernetesHttpApiClient(options: {
	apiServerUrl: string;
	bearerToken?: string;
	ca?: Buffer;
	pollIntervalMs?: number;
}): KubernetesApiClient {
	const baseUrl = new URL(options.apiServerUrl);
	const pollIntervalMs = options.pollIntervalMs ?? 2_000;

	async function request<T>(input: {
		method: string;
		path: string;
		body?: unknown;
		contentType?: string;
		ok?: readonly number[];
	}): Promise<{ status: number; body: T | null; text: string }> {
		const url = new URL(input.path, baseUrl);
		const serialized = input.body === undefined ? undefined : JSON.stringify(input.body);
		const headers: Record<string, string> = {
			Accept: "application/json",
			...(serialized !== undefined
				? { "Content-Type": input.contentType ?? "application/json" }
				: {}),
			...(options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : {}),
		};
		const transport = url.protocol === "http:" ? http : https;
		const response = await new Promise<{ statusCode: number; text: string }>((resolve, reject) => {
			const req = transport.request(
				url,
				{
					method: input.method,
					headers,
					...(url.protocol === "https:" && options.ca ? { ca: options.ca } : {}),
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer | string) =>
						chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
					);
					res.on("end", () => {
						resolve({
							statusCode: res.statusCode ?? 0,
							text: Buffer.concat(chunks).toString("utf8"),
						});
					});
				},
			);
			req.on("error", reject);
			if (serialized !== undefined) req.write(serialized);
			req.end();
		});
		const ok = input.ok ?? [200, 201, 202];
		if (!ok.includes(response.statusCode)) {
			throw new Error(
				`Kubernetes API ${input.method} ${input.path} failed with HTTP ${response.statusCode}: ${response.text}`,
			);
		}
		const text = response.text.trim();
		return {
			status: response.statusCode,
			text: response.text,
			body: text.length > 0 ? (JSON.parse(text) as T) : null,
		};
	}

	async function exists(path: string): Promise<KubernetesObjectResponse | null> {
		const result = await request<KubernetesObjectResponse>({
			method: "GET",
			path,
			ok: [200, 404],
		});
		return result.status === 404 ? null : result.body;
	}

	/** Idempotent create-or-patch for K8s resources. */
	async function upsertResource(input: {
		existsPath: string;
		createPath: string;
		createBody: unknown;
		patchPath: string;
		patchBody: unknown;
	}): Promise<void> {
		const existing = await exists(input.existsPath);
		if (!existing) {
			await request({ method: "POST", path: input.createPath, body: input.createBody });
		} else {
			await request({
				method: "PATCH",
				path: input.patchPath,
				contentType: "application/merge-patch+json",
				body: input.patchBody,
			});
		}
	}

	function labelSelector(labels: Record<string, string>): string {
		return Object.entries(labels)
			.map(([key, value]) => `${key}=${value}`)
			.join(",");
	}

	function namespaceSummary(item: KubernetesObjectResponse): KubernetesNamespaceSummary | null {
		const name = item.metadata?.name;
		if (!name) return null;
		return { name, labels: { ...(item.metadata?.labels ?? {}) } };
	}

	function podSummary(item: KubernetesObjectResponse): KubernetesPodSummary | null {
		const name = item.metadata?.name;
		const namespace = item.metadata?.namespace;
		if (!name || !namespace) return null;
		return {
			name,
			namespace,
			labels: { ...(item.metadata?.labels ?? {}) },
			phase: item.status?.phase,
		};
	}

	function podExitInfo(item: KubernetesObjectResponse | null): WorkerExitInfo {
		if (!item) return { exitCode: 0, signal: null, reason: "Deleted" };
		const statusWithTermination = item.status?.containerStatuses?.find(
			(s) => s.state?.terminated || s.lastState?.terminated,
		);
		const status =
			statusWithTermination?.state?.terminated ?? statusWithTermination?.lastState?.terminated;
		return mapKubernetesPodExit({
			phase: item.status?.phase,
			reason: status?.reason ?? item.status?.reason,
			exitCode: status?.exitCode,
			signal: status?.signal ? `SIG${status.signal}` : null,
			oomKilled: status?.reason === "OOMKilled",
		});
	}

	return {
		async ensureNamespace(manifest: KubernetesProcessNamespaceManifest): Promise<void> {
			const name = manifest.metadata.name;
			await upsertResource({
				existsPath: `/api/v1/namespaces/${encodeURIComponent(name)}`,
				createPath: "/api/v1/namespaces",
				createBody: manifest,
				patchPath: `/api/v1/namespaces/${encodeURIComponent(name)}`,
				patchBody: { metadata: { labels: manifest.metadata.labels } },
			});
		},
		async deleteNamespace(name: string): Promise<void> {
			await request({
				method: "DELETE",
				path: `/api/v1/namespaces/${encodeURIComponent(name)}`,
				ok: [200, 202, 404],
			});
		},
		async listNamespaces(labels: Record<string, string>): Promise<KubernetesNamespaceSummary[]> {
			const selector = labelSelector(labels);
			const result = await request<KubernetesListResponse<KubernetesObjectResponse>>({
				method: "GET",
				path: `/api/v1/namespaces?labelSelector=${encodeURIComponent(selector)}`,
			});
			return (result.body?.items ?? []).map(namespaceSummary).filter((item) => item !== null);
		},
		async ensureServiceAccount(name, namespace, labels): Promise<void> {
			const enc = (s: string) => encodeURIComponent(s);
			await upsertResource({
				existsPath: `/api/v1/namespaces/${enc(namespace)}/serviceaccounts/${enc(name)}`,
				createPath: `/api/v1/namespaces/${enc(namespace)}/serviceaccounts`,
				createBody: {
					apiVersion: "v1",
					kind: "ServiceAccount",
					metadata: { name, namespace, labels },
					automountServiceAccountToken: false,
				},
				patchPath: `/api/v1/namespaces/${enc(namespace)}/serviceaccounts/${enc(name)}`,
				patchBody: { metadata: { labels } },
			});
		},
		async ensureConfigMap(manifest: KubernetesConfigMapManifest): Promise<void> {
			const name = encodeURIComponent(manifest.metadata.name);
			const namespace = encodeURIComponent(manifest.metadata.namespace);
			await upsertResource({
				existsPath: `/api/v1/namespaces/${namespace}/configmaps/${name}`,
				createPath: `/api/v1/namespaces/${namespace}/configmaps`,
				createBody: manifest,
				patchPath: `/api/v1/namespaces/${namespace}/configmaps/${name}`,
				patchBody: { metadata: { labels: manifest.metadata.labels }, data: manifest.data },
			});
		},
		async getDockerConfigJsonSecret(name: string, namespace: string): Promise<string> {
			const result = await request<KubernetesObjectResponse>({
				method: "GET",
				path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`,
				ok: [200, 404],
			});
			if (result.status === 404) {
				throw new Error(`Kubernetes image-pull Secret ${namespace}/${name} was not found`);
			}
			if (result.body?.type !== "kubernetes.io/dockerconfigjson") {
				throw new Error(
					`Kubernetes image-pull Secret ${namespace}/${name} must have type kubernetes.io/dockerconfigjson`,
				);
			}
			const dockerConfigJson = result.body.data?.[".dockerconfigjson"];
			if (!dockerConfigJson) {
				throw new Error(
					`Kubernetes image-pull Secret ${namespace}/${name} is missing .dockerconfigjson`,
				);
			}
			return dockerConfigJson;
		},
		async ensureDockerConfigJsonSecret(
			manifest: KubernetesDockerConfigJsonSecretManifest,
		): Promise<void> {
			const namespace = encodeURIComponent(manifest.metadata.namespace);
			const name = encodeURIComponent(manifest.metadata.name);
			const created = await request({
				method: "POST",
				path: `/api/v1/namespaces/${namespace}/secrets`,
				body: manifest,
				ok: [201, 409],
			});
			if (created.status === 409) {
				await request({
					method: "PATCH",
					path: `/api/v1/namespaces/${namespace}/secrets/${name}`,
					contentType: "application/merge-patch+json",
					body: {
						metadata: { labels: manifest.metadata.labels },
						type: manifest.type,
						data: manifest.data,
					},
				});
			}
		},
		async ensurePersistentVolumeClaim(
			manifest: KubernetesPersistentVolumeClaimManifest,
		): Promise<void> {
			const name = encodeURIComponent(manifest.metadata.name);
			const namespace = encodeURIComponent(manifest.metadata.namespace);
			const existing = await exists(
				`/api/v1/namespaces/${namespace}/persistentvolumeclaims/${name}`,
			);
			if (!existing) {
				await request({
					method: "POST",
					path: `/api/v1/namespaces/${namespace}/persistentvolumeclaims`,
					body: manifest,
				});
			}
		},
		async deletePersistentVolumeClaim(name: string, namespace: string): Promise<void> {
			await request({
				method: "DELETE",
				path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims/${encodeURIComponent(name)}`,
				ok: [200, 202, 404],
			});
		},
		async createPod(manifest: KubernetesPodManifest): Promise<void> {
			await request({
				method: "POST",
				path: `/api/v1/namespaces/${encodeURIComponent(manifest.metadata.namespace)}/pods`,
				body: manifest,
			});
		},
		async deletePod(name: string, namespace: string, options: { gracePeriodSeconds: number }) {
			await request({
				method: "DELETE",
				path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`,
				body: { gracePeriodSeconds: options.gracePeriodSeconds },
				ok: [200, 202, 404],
			});
		},
		async getPod(name: string, namespace: string): Promise<KubernetesPodSummary | null> {
			const result = await request<KubernetesObjectResponse>({
				method: "GET",
				path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`,
				ok: [200, 404],
			});
			return result.status === 404 ? null : podSummary(result.body ?? {});
		},
		async listPods(
			namespace: string,
			labels: Record<string, string>,
		): Promise<KubernetesPodSummary[]> {
			const selector = labelSelector(labels);
			const result = await request<KubernetesListResponse<KubernetesObjectResponse>>({
				method: "GET",
				path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent(selector)}`,
			});
			return (result.body?.items ?? []).map(podSummary).filter((item) => item !== null);
		},
		onPodExit(
			name: string,
			namespace: string,
			listener: (info: WorkerExitInfo) => void,
		): () => void {
			let stopped = false;
			const timer = setInterval(async () => {
				if (stopped) return;
				try {
					const result = await request<KubernetesObjectResponse>({
						method: "GET",
						path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`,
						ok: [200, 404],
					});
					if (
						result.status === 404 ||
						["Failed", "Succeeded"].includes(result.body?.status?.phase ?? "")
					) {
						stopped = true;
						clearInterval(timer);
						listener(podExitInfo(result.status === 404 ? null : result.body));
					}
				} catch {
					// Transient API failures are handled by the next poll; the supervisor's
					// heartbeat/startup watchdogs remain the authoritative failure boundary.
				}
			}, pollIntervalMs);
			timer.unref?.();
			return () => {
				stopped = true;
				clearInterval(timer);
			};
		},
	};
}

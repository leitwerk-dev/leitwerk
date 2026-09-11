import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import { URL } from "node:url";
import type {
	KubernetesApiClient,
	KubernetesApiRequestOptions,
	KubernetesNamespaceSummary,
	KubernetesPodSummary,
} from "./kubernetes-api-client.js";
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

const IN_CLUSTER_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const IN_CLUSTER_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const DEFAULT_IN_CLUSTER_API = "https://kubernetes.default.svc";
const TRANSIENT_PLAIN_BAD_REQUEST_MAX_ATTEMPTS = 3;
const TRANSIENT_PLAIN_BAD_REQUEST_BACKOFF_MS = 25;
const MAX_API_ERROR_LENGTH = 2_048;

function boundedApiError(text: string): string {
	let summary = text.trim();
	try {
		const parsed = JSON.parse(summary) as { reason?: unknown; message?: unknown };
		summary = [parsed.reason, parsed.message]
			.filter((value): value is string => typeof value === "string" && value.trim() !== "")
			.join(": ");
	} catch {
		// Plain-text API errors are already summaries.
	}
	if (!summary) return "no diagnostic";
	return summary.length <= MAX_API_ERROR_LENGTH
		? summary
		: `${summary.slice(0, MAX_API_ERROR_LENGTH - 1)}…`;
}

interface KubernetesListResponse<T> {
	metadata?: { continue?: string };
	items?: T[];
}

interface KubernetesObjectResponse {
	spec?: {
		nodeName?: string;
		storageClassName?: string;
		volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }>;
		containers?: Array<{
			name?: string;
			resources?: { limits?: { cpu?: string; memory?: string } };
		}>;
	};
	involvedObject?: { uid?: string; fieldPath?: string };
	firstTimestamp?: string;
	eventTime?: string;
	metadata?: {
		uid?: string;
		creationTimestamp?: string;
		name?: string;
		namespace?: string;
		labels?: Record<string, string>;
	};
	status?: {
		conditions?: Array<{ type?: string; status?: string; lastTransitionTime?: string }>;
		phase?: string;
		reason?: string;
		containerStatuses?: Array<{
			name?: string;
			imageID?: string;
			state?: {
				running?: { startedAt?: string };
				terminated?: {
					startedAt?: string;
					exitCode?: number;
					reason?: string;
					signal?: number;
					message?: string;
				};
			};
			lastState?: {
				terminated?: {
					startedAt?: string;
					exitCode?: number;
					reason?: string;
					signal?: number;
					message?: string;
				};
			};
		}>;
	};
	type?: string;
	reason?: string;
	message?: string;
	count?: number;
	lastTimestamp?: string;
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
		signal?: AbortSignal;
	}): Promise<{ status: number; body: T | null; text: string }> {
		const url = new URL(input.path, baseUrl);
		const serialized = input.body === undefined ? undefined : JSON.stringify(input.body);
		const headers: Record<string, string> = {
			Accept: "application/json",
			...(serialized !== undefined
				? {
						"Content-Type": input.contentType ?? "application/json",
						"Content-Length": String(Buffer.byteLength(serialized)),
					}
				: {}),
			...(options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : {}),
		};
		const transport = url.protocol === "http:" ? http : https;
		let response: { statusCode: number; text: string };
		for (let attempt = 1; ; attempt += 1) {
			input.signal?.throwIfAborted();
			response = await new Promise<{ statusCode: number; text: string }>((resolve, reject) => {
				const req = transport.request(
					url,
					{
						method: input.method,
						headers,
						signal: input.signal,
						...(url.protocol === "https:" && options.ca ? { ca: options.ca } : {}),
					},
					(res) => {
						res.on("error", reject);
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
			const retryableMethod = input.method === "GET" || input.method === "DELETE";
			const transientPlainBadRequest =
				response.statusCode === 400 && response.text.trim() === "400 Bad Request";
			if (
				!retryableMethod ||
				!transientPlainBadRequest ||
				attempt >= TRANSIENT_PLAIN_BAD_REQUEST_MAX_ATTEMPTS
			) {
				break;
			}
			await sleep(TRANSIENT_PLAIN_BAD_REQUEST_BACKOFF_MS * attempt, undefined, {
				signal: input.signal,
			});
		}
		const ok = input.ok ?? [200, 201, 202];
		if (!ok.includes(response.statusCode)) {
			throw new Error(
				`Kubernetes API ${input.method} ${input.path} failed with HTTP ${response.statusCode}: ${boundedApiError(response.text)}`,
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
			uid: item.metadata?.uid,
			createdAt: item.metadata?.creationTimestamp,
			scheduledAt: item.status?.conditions?.find(
				(c) => c.type === "PodScheduled" && c.status === "True",
			)?.lastTransitionTime,
			containerStartedAt:
				item.status?.containerStatuses?.find((c) => c.name === "worker")?.state?.running
					?.startedAt ??
				item.status?.containerStatuses?.find((c) => c.name === "worker")?.state?.terminated
					?.startedAt,
			imageId: item.status?.containerStatuses?.find((c) => c.name === "worker")?.imageID,
			node: item.spec?.nodeName,
			pvcName: item.spec?.volumes?.find((v) => v.persistentVolumeClaim)?.persistentVolumeClaim
				?.claimName,
			resources: item.spec?.containers?.find((c) => c.name === "worker")?.resources?.limits,
			phase: item.status?.phase,
		};
	}

	async function listPodEvents(
		name: string,
		namespace: string,
		options?: KubernetesApiRequestOptions,
	): Promise<KubernetesPodEventSummary[]> {
		const events: KubernetesPodEventSummary[] = [];
		let continuation = "";
		do {
			const result = await request<KubernetesListResponse<KubernetesObjectResponse>>({
				method: "GET",
				signal: options?.signal,
				path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/events?fieldSelector=${encodeURIComponent(`involvedObject.kind=Pod,involvedObject.name=${name}`)}&limit=100${continuation ? `&continue=${encodeURIComponent(continuation)}` : ""}`,
			});
			events.push(
				...(result.body?.items ?? []).map((event) => ({
					type: event.type,
					reason: event.reason,
					message: event.message,
					count: event.count,
					lastTimestamp: event.lastTimestamp,
					firstTimestamp: event.firstTimestamp,
					eventTime: event.eventTime,
					objectUid: event.involvedObject?.uid,
					fieldPath: event.involvedObject?.fieldPath,
				})),
			);
			continuation = result.body?.metadata?.continue ?? "";
		} while (continuation);
		return events;
	}

	function podExitInfo(
		item: KubernetesObjectResponse | null,
		events?: KubernetesPodEventSummary[],
		sensitiveValues: readonly string[] = [],
	): WorkerExitInfo {
		if (!item) {
			return mapKubernetesPodExit({
				reason: "Deleted",
				exitCode: 0,
				signal: null,
				events,
				sensitiveValues,
			});
		}
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
			terminationMessage: status?.message,
			events,
			sensitiveValues,
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
		async deletePod(name, namespace, options) {
			await request({
				method: "DELETE",
				path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`,
				body: {
					apiVersion: "v1",
					kind: "DeleteOptions",
					gracePeriodSeconds: options.gracePeriodSeconds,
				},
				ok: [200, 202, 404],
				signal: options.signal,
			});
		},
		async getPod(name, namespace, options): Promise<KubernetesPodSummary | null> {
			const result = await request<KubernetesObjectResponse>({
				method: "GET",
				path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`,
				ok: [200, 404],
				signal: options?.signal,
			});
			return result.status === 404 ? null : podSummary(result.body ?? {});
		},
		async getPersistentVolumeClaim(name, namespace, options) {
			const result = await request<KubernetesObjectResponse>({
				method: "GET",
				path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims/${encodeURIComponent(name)}`,
				signal: options?.signal,
				ok: [200, 404],
			});
			return result.status === 404
				? null
				: {
						uid: result.body?.metadata?.uid,
						phase: result.body?.status?.phase,
						storageClass: result.body?.spec?.storageClassName,
					};
		},
		listPodEvents,
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
			options,
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
						let events: KubernetesPodEventSummary[] = [];
						try {
							events = await listPodEvents(name, namespace);
						} catch {
							// Exit status remains useful when event access fails transiently.
						}
						listener(
							podExitInfo(
								result.status === 404 ? null : result.body,
								events,
								options?.sensitiveValues,
							),
						);
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

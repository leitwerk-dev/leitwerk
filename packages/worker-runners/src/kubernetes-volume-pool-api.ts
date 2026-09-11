/** Kubernetes objects used for native PVC provisioning and safe PV rebinding. */
export interface PoolObject {
	apiVersion?: string;
	kind?: string;
	metadata: {
		name: string;
		namespace?: string;
		uid?: string;
		resourceVersion?: string;
		deletionTimestamp?: string;
		labels?: Record<string, string>;
		annotations?: Record<string, string>;
		ownerReferences?: Array<{ uid: string; [key: string]: unknown }>;
	};
	spec: {
		volumeName?: string;
		storageClassName?: string;
		claimRef?: { uid?: string; name?: string; namespace?: string };
		persistentVolumeReclaimPolicy?: string;
		[key: string]: unknown;
	};
	status?: { phase?: string };
}

export interface PoolStorageClass {
	apiVersion?: string;
	kind?: string;
	metadata: PoolObject["metadata"];
	provisioner: string;
	parameters?: Record<string, string>;
	reclaimPolicy?: string;
	mountOptions?: string[];
	allowVolumeExpansion?: boolean;
	volumeBindingMode?: string;
	allowedTopologies?: unknown[];
}

export interface VolumePoolApi {
	getStorageClass(name: string, signal: AbortSignal): Promise<PoolStorageClass | null>;
	listStorageClasses(selector: string, signal: AbortSignal): Promise<PoolStorageClass[]>;
	createStorageClass(value: PoolStorageClass, signal: AbortSignal): Promise<void>;
	deleteStorageClass(value: PoolStorageClass, signal: AbortSignal): Promise<void>;
	list(
		kind: "persistentvolumes" | "persistentvolumeclaims",
		namespace: string,
		selector: string,
		signal: AbortSignal,
	): Promise<PoolObject[]>;
	get(
		kind: string,
		namespace: string,
		name: string,
		signal: AbortSignal,
	): Promise<PoolObject | null>;
	create(kind: string, namespace: string, object: PoolObject, signal: AbortSignal): Promise<void>;
	patchVolume(
		volume: PoolObject,
		operations: Array<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<void>;
	delete(kind: string, namespace: string, object: PoolObject, signal: AbortSignal): Promise<void>;
}

type Request = <T>(input: {
	method: string;
	path: string;
	body?: unknown;
	contentType?: string;
	ok?: readonly number[];
	signal?: AbortSignal;
}) => Promise<{ status: number; body: T | null }>;

export function createVolumePoolApi(request: Request): VolumePoolApi {
	const path = (kind: string, namespace: string, name?: string) =>
		`/api/v1/${namespace ? `namespaces/${encodeURIComponent(namespace)}/` : ""}${kind}${name ? `/${encodeURIComponent(name)}` : ""}`;
	const bounded = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
	const classes = "/apis/storage.k8s.io/v1/storageclasses";
	return {
		async getStorageClass(name, signal) {
			const response = await request<PoolStorageClass>({
				method: "GET",
				path: `${classes}/${encodeURIComponent(name)}`,
				ok: [200, 404],
				signal: bounded(signal),
			});
			return response.status === 404 ? null : response.body;
		},
		async listStorageClasses(selector, signal) {
			const items: PoolStorageClass[] = [];
			let cursor = "";
			do {
				const query = new URLSearchParams({
					labelSelector: selector,
					limit: "100",
					...(cursor ? { continue: cursor } : {}),
				});
				const response = await request<{
					items: PoolStorageClass[];
					metadata?: { continue?: string };
				}>({ method: "GET", path: `${classes}?${query}`, signal: bounded(signal) });
				if (!response.body) throw new Error("Missing StorageClass list response");
				items.push(...response.body.items);
				cursor = response.body.metadata?.continue ?? "";
			} while (cursor);
			return items;
		},
		async createStorageClass(value, signal) {
			await request({
				method: "POST",
				path: classes,
				body: value,
				ok: [201, 409],
				signal: bounded(signal),
			});
		},
		async deleteStorageClass(value, signal) {
			if (!value.metadata.uid) throw new Error("Staging StorageClass identity is missing");
			await request({
				method: "DELETE",
				path: `${classes}/${encodeURIComponent(value.metadata.name)}`,
				body: {
					apiVersion: "v1",
					kind: "DeleteOptions",
					preconditions: { uid: value.metadata.uid },
				},
				ok: [200, 202, 404],
				signal: bounded(signal),
			});
		},
		async list(kind, namespace, selector, signal) {
			const items: PoolObject[] = [];
			let cursor = "";
			do {
				const query = new URLSearchParams({
					labelSelector: selector,
					limit: "100",
					...(cursor ? { continue: cursor } : {}),
				});
				const result = await request<{ items: PoolObject[]; metadata?: { continue?: string } }>({
					method: "GET",
					path: `${path(kind, namespace)}?${query}`,
					signal: bounded(signal),
				});
				if (!result.body) throw new Error("Missing volume-pool list response");
				items.push(...result.body.items);
				cursor = result.body.metadata?.continue ?? "";
			} while (cursor);
			return items;
		},
		async get(kind, namespace, name, signal) {
			const result = await request<PoolObject>({
				method: "GET",
				path: path(kind, namespace, name),
				ok: [200, 404],
				signal: bounded(signal),
			});
			return result.status === 404 ? null : result.body;
		},
		async create(kind, namespace, object, signal) {
			await request({
				method: "POST",
				path: path(kind, namespace),
				body: object,
				ok: [201, 409],
				signal: bounded(signal),
			});
		},
		async patchVolume(volume, operations, signal) {
			if (!volume.metadata.uid || !volume.metadata.resourceVersion)
				throw new Error("PV identity is missing");
			await request({
				method: "PATCH",
				path: path("persistentvolumes", "", volume.metadata.name),
				contentType: "application/json-patch+json",
				body: [
					{ op: "test", path: "/metadata/uid", value: volume.metadata.uid },
					{ op: "test", path: "/metadata/resourceVersion", value: volume.metadata.resourceVersion },
					...operations,
				],
				signal: bounded(signal),
			});
		},
		async delete(kind, namespace, object, signal) {
			if (!object.metadata.uid) throw new Error("Preparation resource identity is missing");
			await request({
				method: "DELETE",
				path: path(kind, namespace, object.metadata.name),
				body: {
					apiVersion: "v1",
					kind: "DeleteOptions",
					preconditions: { uid: object.metadata.uid },
					gracePeriodSeconds: 1,
				},
				ok: [200, 202, 404],
				signal: bounded(signal),
			});
		},
	};
}

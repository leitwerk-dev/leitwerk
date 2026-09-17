/** Kubernetes objects used for native PVC provisioning and safe PV rebinding. */
/** @internal */
export interface PoolObject {
	/** @internal */
	apiVersion?: string;
	/** @internal */
	kind?: string;
	/** @internal */
	metadata: {
		/** @internal */
		name: string;
		/** @internal */
		namespace?: string;
		/** @internal */
		uid?: string;
		/** @internal */
		resourceVersion?: string;
		/** @internal */
		deletionTimestamp?: string;
		/** @internal */
		labels?: Record<string, string>;
		/** @internal */
		annotations?: Record<string, string>;
		/** @internal */
		ownerReferences?: Array<{
			/** @internal */
			uid: string;
			/** @internal */
			[key: string]: unknown;
		}>;
	};
	/** @internal */
	spec: {
		/** @internal */
		volumeName?: string;
		/** @internal */
		storageClassName?: string;
		/** @internal */
		claimRef?: {
			/** @internal */
			uid?: string;
			/** @internal */
			name?: string;
			/** @internal */
			namespace?: string;
		};
		/** @internal */
		persistentVolumeReclaimPolicy?: string;
		/** @internal */
		[key: string]: unknown;
	};
	/** @internal */
	status?: {
		/** @internal */
		phase?: string;
	};
}

/** @internal */
export interface PoolStorageClass {
	/** @internal */
	apiVersion?: string;
	/** @internal */
	kind?: string;
	/** @internal */
	metadata: PoolObject["metadata"];
	/** @internal */
	provisioner: string;
	/** @internal */
	parameters?: Record<string, string>;
	/** @internal */
	reclaimPolicy?: string;
	/** @internal */
	mountOptions?: string[];
	/** @internal */
	allowVolumeExpansion?: boolean;
	/** @internal */
	volumeBindingMode?: string;
	/** @internal */
	allowedTopologies?: unknown[];
}

/** @internal */
export interface VolumePoolApi {
	/** @internal */
	getStorageClass(name: string, signal: AbortSignal): Promise<PoolStorageClass | null>;
	/** @internal */
	listStorageClasses(selector: string, signal: AbortSignal): Promise<PoolStorageClass[]>;
	/** @internal */
	createStorageClass(value: PoolStorageClass, signal: AbortSignal): Promise<void>;
	/** @internal */
	deleteStorageClass(value: PoolStorageClass, signal: AbortSignal): Promise<void>;
	/** @internal */
	list(
		kind: "persistentvolumes" | "persistentvolumeclaims",
		namespace: string,
		selector: string,
		signal: AbortSignal,
	): Promise<PoolObject[]>;
	/** @internal */
	get(
		kind: string,
		namespace: string,
		name: string,
		signal: AbortSignal,
	): Promise<PoolObject | null>;
	/** @internal */
	create(kind: string, namespace: string, object: PoolObject, signal: AbortSignal): Promise<void>;
	/** @internal */
	patchVolume(
		volume: PoolObject,
		operations: Array<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<void>;
	/** @internal */
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
	async function list<T>(collection: string, selector: string, signal: AbortSignal): Promise<T[]> {
		const items: T[] = [];
		let cursor = "";
		do {
			const query = new URLSearchParams({
				labelSelector: selector,
				limit: "100",
				...(cursor ? { continue: cursor } : {}),
			});
			const response = await request<{ items: T[]; metadata?: { continue?: string } }>({
				method: "GET",
				path: `${collection}?${query}`,
				signal: bounded(signal),
			});
			if (!response.body) throw new Error("Missing volume-pool list response");
			items.push(...response.body.items);
			cursor = response.body.metadata?.continue ?? "";
		} while (cursor);
		return items;
	}

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
		listStorageClasses(selector, signal) {
			return list<PoolStorageClass>(classes, selector, signal);
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
		list(kind, namespace, selector, signal) {
			return list<PoolObject>(path(kind, namespace), selector, signal);
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

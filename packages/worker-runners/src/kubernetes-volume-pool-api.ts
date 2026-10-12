import { createPreparationApi, type PreparationRequest } from "./kubernetes-preparation-api.js";

/** Kubernetes objects used for native PVC provisioning and safe PV rebinding. @internal */
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

/** @internal */
export function createVolumePoolApi(request: PreparationRequest): VolumePoolApi {
	const api = createPreparationApi(request, "volume-pool");
	const path = (kind: string, namespace: string, name?: string) =>
		`/api/v1/${namespace ? `namespaces/${encodeURIComponent(namespace)}/` : ""}${kind}${name ? `/${encodeURIComponent(name)}` : ""}`;
	const classes = "/apis/storage.k8s.io/v1/storageclasses";

	return {
		getStorageClass: (name, signal) =>
			api.get<PoolStorageClass>(`${classes}/${encodeURIComponent(name)}`, signal),
		listStorageClasses: (selector, signal) => api.list<PoolStorageClass>(classes, selector, signal),
		createStorageClass: (value, signal) => api.create(classes, value, signal),
		deleteStorageClass: (value, signal) =>
			api.delete(
				`${classes}/${encodeURIComponent(value.metadata.name)}`,
				value.metadata.uid,
				signal,
				"Staging StorageClass",
			),
		list: (kind, namespace, selector, signal) =>
			api.list<PoolObject>(path(kind, namespace), selector, signal),
		get: (kind, namespace, name, signal) =>
			api.get<PoolObject>(path(kind, namespace, name), signal),
		create: (kind, namespace, object, signal) => api.create(path(kind, namespace), object, signal),
		async patchVolume(volume, operations, signal) {
			if (!volume.metadata.uid || !volume.metadata.resourceVersion)
				throw new Error("PV identity is missing");
			await api.request({
				method: "PATCH",
				path: path("persistentvolumes", "", volume.metadata.name),
				contentType: "application/json-patch+json",
				body: [
					{ op: "test", path: "/metadata/uid", value: volume.metadata.uid },
					{ op: "test", path: "/metadata/resourceVersion", value: volume.metadata.resourceVersion },
					...operations,
				],
				signal,
			});
		},
		delete: (kind, namespace, object, signal) =>
			api.delete(
				path(kind, namespace, object.metadata.name),
				object.metadata.uid,
				signal,
				"Preparation resource",
				1,
			),
	};
}

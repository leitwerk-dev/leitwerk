import { createPreparationApi, type PreparationRequest } from "./kubernetes-preparation-api.js";
import type { PoolObject } from "./kubernetes-volume-pool-api.js";

/** @internal */
export interface PreparationNode {
	/** @internal */
	metadata: PoolObject["metadata"];
	/** @internal */
	spec?: {
		/** @internal */
		unschedulable?: boolean;
		/** @internal */
		taints?: Array<{
			/** @internal */
			key: string;
			/** @internal */
			value?: string;
			/** @internal */
			effect: string;
		}>;
	};
	/** @internal */
	status?: {
		/** @internal */
		conditions?: Array<{
			/** @internal */
			type: string;
			/** @internal */
			status: string;
		}>;
	};
}

/** @internal */
export interface ImagePreparationPod extends Omit<PoolObject, "status"> {
	/** @internal */
	status?: {
		/** @internal */
		phase?: string;
		/** @internal */
		containerStatuses?: Array<{
			/** @internal */
			state?: {
				/** @internal */
				waiting?: {
					/** @internal */ reason?: string;
				};
				/** @internal */
				terminated?: {
					/** @internal */ finishedAt?: string;
				};
			};
		}>;
	};
}

/** @internal */
export interface ImagePreloadApi {
	/** @internal */
	listNodes(signal: AbortSignal): Promise<PreparationNode[]>;
	/** @internal */
	listPods(
		namespace: string,
		selector: string,
		signal: AbortSignal,
	): Promise<ImagePreparationPod[]>;
	/** @internal */
	getPod(namespace: string, name: string, signal: AbortSignal): Promise<ImagePreparationPod | null>;
	/** @internal */
	createPod(namespace: string, pod: ImagePreparationPod, signal: AbortSignal): Promise<void>;
	/** @internal */
	deletePod(namespace: string, pod: ImagePreparationPod, signal: AbortSignal): Promise<void>;
}

/** @internal */
export function createImagePreloadApi(request: PreparationRequest): ImagePreloadApi {
	const api = createPreparationApi(request, "image-preparation");
	const pods = (namespace: string, name?: string) =>
		`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods${name ? `/${encodeURIComponent(name)}` : ""}`;
	return {
		listNodes: (signal) => api.list<PreparationNode>("/api/v1/nodes", "", signal),
		listPods: (namespace, selector, signal) =>
			api.list<ImagePreparationPod>(pods(namespace), selector, signal),
		getPod: (namespace, name, signal) =>
			api.get<ImagePreparationPod>(pods(namespace, name), signal),
		createPod: (namespace, pod, signal) => api.create(pods(namespace), pod, signal),
		deletePod: (namespace, pod, signal) =>
			api.delete(
				pods(namespace, pod.metadata.name),
				pod.metadata.uid,
				signal,
				"Image preparation Pod",
				1,
			),
	};
}

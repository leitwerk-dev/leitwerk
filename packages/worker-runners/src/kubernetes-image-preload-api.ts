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

type Request = <T>(input: {
	/** @internal */
	method: string;
	/** @internal */
	path: string;
	/** @internal */
	body?: unknown;
	/** @internal */
	ok?: readonly number[];
	/** @internal */
	signal?: AbortSignal;
}) => Promise<{
	/** @internal */
	status: number;
	/** @internal */
	body: T | null;
}>;

/** @internal */
export function createImagePreloadApi(request: Request): ImagePreloadApi {
	const pods = (namespace: string, name?: string) =>
		`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods${name ? `/${encodeURIComponent(name)}` : ""}`;
	const bounded = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
	async function list<T>(path: string, selector: string, signal: AbortSignal): Promise<T[]> {
		const items: T[] = [];
		let cursor = "";
		do {
			const query = new URLSearchParams({ labelSelector: selector, limit: "100" });
			if (cursor) query.set("continue", cursor);
			const response = await request<{
				/** @internal */ items: T[] /** @internal */;
				metadata?: {
					/** @internal */ continue?: string;
				};
			}>({
				method: "GET",
				path: `${path}?${query}`,
				signal: bounded(signal),
			});
			if (!response.body) throw new Error("Missing image-preparation list response");
			items.push(...response.body.items);
			cursor = response.body.metadata?.continue ?? "";
		} while (cursor);
		return items;
	}
	return {
		listNodes: (signal) => list<PreparationNode>("/api/v1/nodes", "", signal),
		listPods: (namespace, selector, signal) =>
			list<ImagePreparationPod>(pods(namespace), selector, signal),
		async getPod(namespace, name, signal) {
			const response = await request<ImagePreparationPod>({
				method: "GET",
				path: pods(namespace, name),
				ok: [200, 404],
				signal: bounded(signal),
			});
			return response.status === 404 ? null : response.body;
		},
		async createPod(namespace, pod, signal) {
			await request({
				method: "POST",
				path: pods(namespace),
				body: pod,
				ok: [201, 409],
				signal: bounded(signal),
			});
		},
		async deletePod(namespace, pod, signal) {
			if (!pod.metadata.uid) throw new Error("Image preparation Pod identity is missing");
			await request({
				method: "DELETE",
				path: pods(namespace, pod.metadata.name),
				body: {
					apiVersion: "v1",
					kind: "DeleteOptions",
					preconditions: { uid: pod.metadata.uid },
					gracePeriodSeconds: 1,
				},
				ok: [200, 202, 404],
				signal: bounded(signal),
			});
		},
	};
}

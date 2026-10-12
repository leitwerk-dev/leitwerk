import { createHash } from "node:crypto";
import type {
	ImagePreloadApi,
	ImagePreparationPod,
	PreparationNode,
} from "./kubernetes-image-preload-api.js";
import { buildPreparationPodSpec, createPreparationController } from "./kubernetes-preparation.js";

export const IMAGE_PRELOAD_LABEL = "leitwerk.dev/image-preload";
const NODE_UID = "leitwerk.dev/preparation-node-uid";
const NODE_NAME = "leitwerk.dev/preparation-node-name";
const IMAGE = "leitwerk.dev/preparation-image";
const INTERVAL = 30_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** @internal */
export interface ImagePreparationEvent {
	/** @internal */
	component: "image-preparation";
	/** @internal */
	outcome: "succeeded" | "failed";
	/** @internal */
	node?: string;
	/** @internal */
	nodeUid?: string;
	/** @internal */
	image?: string;
	/** @internal */
	pod?: string;
	/** @internal */
	reason?: string;
}

/** @internal */
export function immutableWorkerImage(image: string): string {
	const match = /^([a-zA-Z0-9][a-zA-Z0-9._:/-]*)@(sha256:[0-9a-f]{64})$/.exec(image);
	if (!match) throw new Error("Image preloading requires digest-qualified worker images");
	return `${match[1].replace(/:[^/:]+$/, "")}@${match[2]}`;
}

/** @internal */
export function eligiblePreparationNode(
	node: PreparationNode,
	selector: Record<string, string>,
	tolerations: unknown[],
): boolean {
	if (!node.metadata.uid || node.metadata.deletionTimestamp || node.spec?.unschedulable)
		return false;
	if (
		!node.status?.conditions?.some(
			(condition) => condition.type === "Ready" && condition.status === "True",
		)
	)
		return false;
	if (!Object.entries(selector).every(([key, value]) => node.metadata.labels?.[key] === value))
		return false;
	return (node.spec?.taints ?? []).every((taint) => {
		if (!["NoSchedule", "NoExecute"].includes(taint.effect)) return true;
		return tolerations.some((value) => {
			if (!value || typeof value !== "object") return false;
			const tolerance = value as Record<string, unknown>;
			if (tolerance.effect && tolerance.effect !== taint.effect) return false;
			if (tolerance.operator === "Exists") return !tolerance.key || tolerance.key === taint.key;
			return (
				(!tolerance.operator || tolerance.operator === "Equal") &&
				tolerance.key === taint.key &&
				(tolerance.value ?? "") === (taint.value ?? "")
			);
		});
	});
}

/** @internal */
export function createKubernetesImagePreload(options: {
	/** @internal */
	api: ImagePreloadApi;
	/** @internal */
	namespace: string;
	/** @internal */
	images: string[];
	/** @internal */
	imagePullSecrets?: string[];
	/** @internal */
	nodeSelector?: Record<string, string>;
	/** Other worker placements to prepare, deduplicated by node and image. @internal */
	additionalNodeSelectors?: Record<string, string>[];
	/** @internal */
	tolerations?: unknown[];
	/** @internal */
	onEvent?: (event: ImagePreparationEvent) => void;
}) {
	const { api, namespace } = options;
	const nodeSelectors = [options.nodeSelector ?? {}, ...(options.additionalNodeSelectors ?? [])];
	const selectorForNode = (node: PreparationNode) =>
		nodeSelectors.find((selector) =>
			eligiblePreparationNode(node, selector, options.tolerations ?? []),
		);
	const images = [...new Set(options.images.map(immutableWorkerImage))];
	const preloadId = hash(namespace).slice(0, 16);
	const selector = `${IMAGE_PRELOAD_LABEL}=${preloadId}`;
	const labels = {
		"leitwerk.dev/managed-by": "leitwerk",
		"leitwerk.dev/component": "image-preparation",
		[IMAGE_PRELOAD_LABEL]: preloadId,
	};
	const podName = (uid: string, image: string) =>
		`lw-image-${hash(`${uid}/${image}`).slice(0, 40)}`;
	const reported = new Map<string, string>();
	const failedSince = new Map<string, number>();

	function owned(pod: ImagePreparationPod) {
		const annotations = pod.metadata.annotations ?? {};
		const uid = annotations[NODE_UID];
		const name = annotations[NODE_NAME];
		const image = annotations[IMAGE];
		const containers = pod.spec.containers as
			| Array<{
					/** @internal */ image?: string /** @internal */;
					command?: string[];
			  }>
			| undefined;
		return (
			pod.metadata.namespace === namespace &&
			!!pod.metadata.uid &&
			!!uid &&
			!!name &&
			!!image &&
			Object.entries(labels).every(([key, value]) => pod.metadata.labels?.[key] === value) &&
			pod.metadata.name === podName(uid, image) &&
			pod.metadata.ownerReferences?.some(
				(owner) =>
					owner.apiVersion === "v1" &&
					owner.kind === "Node" &&
					owner.name === name &&
					owner.uid === uid,
			) &&
			pod.spec.nodeName === name &&
			pod.spec.automountServiceAccountToken === false &&
			containers?.length === 1 &&
			containers[0].image === image &&
			JSON.stringify(containers[0].command) === JSON.stringify(["node", "-e", "process.exit(0)"])
		);
	}
	function report(
		pod: ImagePreparationPod,
		outcome: ImagePreparationEvent["outcome"],
		reason?: string,
	) {
		const uid = pod.metadata.uid ?? pod.metadata.name;
		const state = `${outcome}/${reason ?? ""}`;
		if (reported.get(uid) === state) return;
		reported.set(uid, state);
		options.onEvent?.({
			component: "image-preparation",
			outcome,
			reason,
			pod: pod.metadata.name,
			node: pod.metadata.annotations?.[NODE_NAME],
			nodeUid: pod.metadata.annotations?.[NODE_UID],
			image: pod.metadata.annotations?.[IMAGE],
		});
	}
	function manifest(
		node: PreparationNode,
		image: string,
		nodeSelector: Record<string, string>,
	): ImagePreparationPod {
		const uid = node.metadata.uid ?? "";
		return {
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name: podName(uid, image),
				namespace,
				labels,
				annotations: { [NODE_UID]: uid, [NODE_NAME]: node.metadata.name, [IMAGE]: image },
				ownerReferences: [{ apiVersion: "v1", kind: "Node", name: node.metadata.name, uid }],
			},
			spec: {
				...buildPreparationPodSpec({
					...options,
					image,
					imagePullPolicy: "IfNotPresent",
					nodeSelector: { ...nodeSelector },
				}),
				nodeName: node.metadata.name,
				securityContext: {
					runAsNonRoot: true,
					runAsUser: 1000,
					runAsGroup: 1000,
					seccompProfile: { type: "RuntimeDefault" },
				},
			},
		};
	}
	/** @internal */
	async function reconcile(signal: AbortSignal) {
		const nodes = await api.listNodes(signal);
		const desired = new Map<string, ImagePreparationPod>();
		for (const node of nodes) {
			const nodeSelector = selectorForNode(node);
			if (!nodeSelector) continue;
			for (const image of images) {
				const pod = manifest(node, image, nodeSelector);
				desired.set(pod.metadata.name, pod);
			}
		}
		const pods = await api.listPods(namespace, selector, signal);
		for (const pod of pods) {
			if (desired.has(pod.metadata.name) || !owned(pod) || pod.metadata.deletionTimestamp) continue;
			try {
				await api.deletePod(namespace, pod, signal);
			} catch {
				if (!signal.aborted) report(pod, "failed", "cleanup_failed");
			}
		}
		const liveUids = new Set(pods.map((pod) => pod.metadata.uid ?? ""));
		for (const uid of reported.keys())
			if (!liveUids.has(uid)) {
				reported.delete(uid);
				failedSince.delete(uid);
			}
		for (const expected of desired.values()) {
			try {
				const pod =
					pods.find((value) => value.metadata.name === expected.metadata.name) ??
					(await api.getPod(namespace, expected.metadata.name, signal));
				if (!pod) {
					await api.createPod(namespace, expected, signal);
					continue;
				}
				if (!owned(pod)) {
					report(expected, "failed", "ownership_mismatch");
					continue;
				}
				if (pod.metadata.deletionTimestamp) continue;
				if (pod.status?.phase === "Succeeded") {
					report(pod, "succeeded");
					continue;
				}
				if (pod.status?.phase === "Failed") {
					report(pod, "failed", "pod_failed");
					const uid = pod.metadata.uid ?? "";
					const finished = Date.parse(
						pod.status.containerStatuses?.[0]?.state?.terminated?.finishedAt ?? "",
					);
					const since = failedSince.get(uid) ?? (Number.isFinite(finished) ? finished : Date.now());
					failedSince.set(uid, since);
					if (Date.now() - since >= INTERVAL) {
						await api.deletePod(namespace, pod, signal);
						await api.createPod(namespace, expected, signal);
					}
					continue;
				}
				const reason = pod.status?.containerStatuses?.[0]?.state?.waiting?.reason;
				if (
					reason === "ErrImagePull" ||
					reason === "ImagePullBackOff" ||
					reason === "InvalidImageName"
				)
					report(pod, "failed", reason);
			} catch {
				if (!signal.aborted) report(expected, "failed", "api_error");
			}
		}
	}
	return {
		/** @internal */
		reconcile,
		...createPreparationController(reconcile, INTERVAL, () =>
			options.onEvent?.({
				component: "image-preparation",
				outcome: "failed",
				reason: "discovery_failed",
			}),
		),
	};
}

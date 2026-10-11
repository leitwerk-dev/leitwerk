import { describe, expect, it, vi } from "vitest";
import {
	createKubernetesImagePreload,
	eligiblePreparationNode,
	type ImagePreparationEvent,
} from "./kubernetes-image-preload.js";
import type {
	ImagePreloadApi,
	ImagePreparationPod,
	PreparationNode,
} from "./kubernetes-image-preload-api.js";
import { createKubernetesPreparation } from "./kubernetes-preparation.js";
import { createKubernetesVolumePool } from "./kubernetes-volume-pool.js";
import type { PoolObject, VolumePoolApi } from "./kubernetes-volume-pool-api.js";

const signal = new AbortController().signal;
const image = `registry.example/worker@sha256:${"a".repeat(64)}`;
const nextImage = `registry.example/worker@sha256:${"b".repeat(64)}`;
const node = (name = "worker", uid = `${name}-uid`): PreparationNode => ({
	metadata: { name, uid, labels: { role: "worker" } },
	spec: {},
	status: { conditions: [{ type: "Ready", status: "True" }] },
});

class ImagesApi implements ImagePreloadApi {
	nodes = [node()];
	pods = new Map<string, ImagePreparationPod>();
	deletions: string[] = [];
	creations = 0;
	failDiscovery = false;
	failCreate = false;
	async listNodes() {
		if (this.failDiscovery) throw new Error("credential must stay private");
		return structuredClone(this.nodes);
	}
	async listPods() {
		return structuredClone([...this.pods.values()]);
	}
	async getPod(_namespace: string, name: string) {
		return structuredClone(this.pods.get(name) ?? null);
	}
	async createPod(namespace: string, pod: ImagePreparationPod) {
		if (this.failCreate) throw new Error("credential must stay private");
		this.creations++;
		this.pods.set(
			pod.metadata.name,
			structuredClone({
				...pod,
				metadata: { ...pod.metadata, namespace, uid: `pod-${this.creations}` },
			}),
		);
	}
	async deletePod(_namespace: string, pod: ImagePreparationPod) {
		expect(this.pods.get(pod.metadata.name)?.metadata.uid).toBe(pod.metadata.uid);
		this.deletions.push(pod.metadata.uid ?? "");
		this.pods.delete(pod.metadata.name);
	}
}
function preload(api: ImagesApi, images = [image], events: ImagePreparationEvent[] = []) {
	return createKubernetesImagePreload({
		api,
		namespace: "server",
		images,
		nodeSelector: { role: "worker" },
		imagePullSecrets: ["registry-source"],
		onEvent: (event) => events.push(event),
	});
}

describe("worker image preparation", () => {
	it("prepares the union of ordinary and Docker placements once per node and image", async () => {
		const api = new ImagesApi();
		api.nodes = [node("ordinary"), node("vm"), node("excluded"), node("cordoned")];
		for (const target of api.nodes)
			target.metadata.labels = { hostname: target.metadata.name, os: "linux" };
		api.nodes[3].spec = { unschedulable: true };
		const controller = createKubernetesImagePreload({
			api,
			namespace: "server",
			images: [image, image],
			nodeSelector: { hostname: "ordinary", os: "linux" },
			additionalNodeSelectors: [
				{ hostname: "vm", os: "linux" },
				{ hostname: "ordinary", os: "linux" },
				{ hostname: "cordoned", os: "linux" },
			],
		});
		await controller.reconcile(signal);
		expect(api.pods.size).toBe(2);
		for (const pod of api.pods.values()) {
			expect(pod.spec.nodeSelector).toEqual({ hostname: pod.spec.nodeName, os: "linux" });
			pod.status = { phase: "Succeeded" };
		}
		await controller.reconcile(signal);
		expect(api.creations).toBe(2);
		expect(api.deletions).toEqual([]);
	});

	it("deduplicates immutable references and retains successful receipts across restarts", async () => {
		const api = new ImagesApi();
		const events: ImagePreparationEvent[] = [];
		await preload(api, [image, image.replace("@", ":release@")], events).reconcile(signal);
		expect(api.creations).toBe(1);
		const pod = [...api.pods.values()][0];
		expect(pod.spec).toMatchObject({
			nodeName: "worker",
			serviceAccountName: "default",
			automountServiceAccountToken: false,
			imagePullSecrets: [{ name: "registry-source" }],
			containers: [{ image, command: ["node", "-e", "process.exit(0)"] }],
		});
		expect(pod.spec.volumes).toBeUndefined();
		expect(JSON.stringify(pod)).not.toContain("LEITWERK_");
		pod.status = { phase: "Succeeded" };
		const restarted = preload(api, [image], events);
		await restarted.reconcile(signal);
		await restarted.reconcile(signal);
		expect(api.creations).toBe(1);
		expect(api.deletions).toEqual([]);
		expect(events).toEqual([
			expect.objectContaining({
				outcome: "succeeded",
				node: "worker",
				nodeUid: "worker-uid",
				image,
			}),
		]);
	});
	it("prepares changed digests and new or replaced nodes, removing only obsolete owned Pods", async () => {
		const api = new ImagesApi();
		await preload(api).reconcile(signal);
		const old = [...api.pods.values()][0];
		old.status = { phase: "Succeeded" };
		api.nodes = [node("worker", "replacement-uid"), node("new-worker")];
		await preload(api, [nextImage]).reconcile(signal);
		expect(api.deletions).toEqual([old.metadata.uid]);
		expect(api.pods.size).toBe(2);
		expect(new Set([...api.pods.values()].map((pod) => pod.spec.nodeName))).toEqual(
			new Set(["worker", "new-worker"]),
		);
	});
	it("does not delete resources with mismatched ownership, or adopt a colliding Pod", async () => {
		const api = new ImagesApi();
		await preload(api).reconcile(signal);
		const pod = [...api.pods.values()][0];
		pod.metadata.ownerReferences = [];
		const events: ImagePreparationEvent[] = [];
		await preload(api, [image], events).reconcile(signal);
		expect(events).toContainEqual(
			expect.objectContaining({ outcome: "failed", reason: "ownership_mismatch" }),
		);
		await preload(api, [nextImage]).reconcile(signal);
		expect(api.deletions).toEqual([]);
		expect(api.pods.size).toBe(2);
	});
	it("keeps pending pull retries with Kubernetes and recreates a failed Pod after thirty seconds", async () => {
		vi.useFakeTimers();
		try {
			const api = new ImagesApi();
			const events: ImagePreparationEvent[] = [];
			const controller = preload(api, [image], events);
			await controller.reconcile(signal);
			const pod = [...api.pods.values()][0];
			pod.status = {
				phase: "Pending",
				containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }],
			};
			await controller.reconcile(signal);
			await controller.reconcile(signal);
			expect(api.deletions).toEqual([]);
			expect(events).toHaveLength(1);
			pod.status = { phase: "Failed" };
			await controller.reconcile(signal);
			vi.setSystemTime(Date.now() + 29_999);
			await controller.reconcile(signal);
			expect(api.creations).toBe(1);
			vi.setSystemTime(Date.now() + 1);
			await controller.reconcile(signal);
			expect(api.creations).toBe(2);
			expect(api.deletions).toEqual([pod.metadata.uid]);
		} finally {
			vi.useRealTimers();
		}
	});
	it("keeps API diagnostics private and continues preparing other node/image pairs", async () => {
		const api = new ImagesApi();
		api.failCreate = true;
		const events: ImagePreparationEvent[] = [];
		await preload(api, [image, nextImage], events).reconcile(signal);
		expect(events).toHaveLength(2);
		expect(JSON.stringify(events)).not.toContain("credential");
		api.failCreate = false;
		await preload(api, [image, nextImage]).reconcile(signal);
		expect(api.pods.size).toBe(2);
	});
	it.each([
		"worker:latest",
		"worker@sha256:abc",
		`${image} extra`,
	])("requires digest-qualified images: %s", (ref) => {
		expect(() => preload(new ImagesApi(), [ref])).toThrow("digest-qualified");
	});
	it.each([
		{ metadata: { ...node().metadata, deletionTimestamp: "now" } },
		{ metadata: { ...node().metadata, uid: undefined } },
		{ metadata: { ...node().metadata, labels: { role: "other" } } },
		{ spec: { unschedulable: true } },
		{ status: { conditions: [{ type: "Ready", status: "False" }] } },
		{ spec: { taints: [{ key: "dedicated", value: "other", effect: "NoSchedule" }] } },
		{ spec: { taints: [{ key: "dedicated", effect: "NoExecute" }] } },
	])("excludes nodes that workers cannot use: %j", (change) => {
		expect(eligiblePreparationNode({ ...node(), ...change }, { role: "worker" }, [])).toBe(false);
	});
	it("handles Equal, Exists and wildcard tolerations with Kubernetes effects", () => {
		const tainted = {
			...node(),
			spec: { taints: [{ key: "dedicated", value: "workers", effect: "NoSchedule" }] },
		};
		for (const tolerance of [
			{ key: "dedicated", value: "workers" },
			{ key: "dedicated", operator: "Exists" },
			{ operator: "Exists" },
		])
			expect(eligiblePreparationNode(tainted, {}, [tolerance])).toBe(true);
		expect(
			eligiblePreparationNode(tainted, {}, [{ operator: "Exists", effect: "NoExecute" }]),
		).toBe(false);
		expect(
			eligiblePreparationNode(
				{ ...tainted, spec: { taints: [{ key: "soft", effect: "PreferNoSchedule" }] } },
				{},
				[],
			),
		).toBe(true);
	});
});

function poolApi(ready: number, failing: boolean) {
	let classesCreated = 0;
	const api: VolumePoolApi = {
		async list(kind) {
			if (failing) throw new Error("pool unavailable");
			return kind === "persistentvolumes"
				? Array.from(
						{ length: ready },
						(_, index): PoolObject => ({
							metadata: {
								name: `spare-${index}`,
								annotations: {
									"leitwerk.dev/preparation-claim-uid": `claim-${index}`,
									"leitwerk.dev/preparation-claim-name": `stage-${index}`,
									"leitwerk.dev/original-reclaim-policy": "Delete",
									"leitwerk.dev/volume-pool-state": "ready",
									"leitwerk.dev/preparation-size": "20Gi",
									"leitwerk.dev/preparation-access-modes": '["ReadWriteOnce"]',
								},
							},
							spec: {},
							status: { phase: "Available" },
						}),
					)
				: [];
		},
		async listStorageClasses() {
			return [];
		},
		async getStorageClass() {
			return { metadata: { name: "storage" }, provisioner: "csi.example" };
		},
		async createStorageClass() {
			classesCreated++;
		},
		async deleteStorageClass() {},
		async get() {
			return null;
		},
		async create() {},
		async patchVolume() {},
		async delete() {},
	};
	return { api, created: () => classesCreated };
}
describe("independent Kubernetes preparation controllers", () => {
	it.each([
		"full",
		"volume-failure",
		"image-failure",
	])("continues the other controller when %s", async (mode) => {
		const api = new ImagesApi();
		api.failDiscovery = mode === "image-failure";
		const poolBoundary = poolApi(mode === "image-failure" ? 0 : 4, mode === "volume-failure");
		const errors: string[] = [];
		const pool = createKubernetesVolumePool({
			api: poolBoundary.api,
			namespace: "server",
			count: 4,
			storageClassName: "storage",
			size: "20Gi",
			accessModes: ["ReadWriteOnce"],
			image,
			onError: () => errors.push("volume"),
		});
		const images = preload(api, [image], []);
		const preparation = createKubernetesPreparation([pool, images]);
		try {
			preparation.start();
			preparation.start();
			await vi.waitFor(() =>
				expect(mode === "image-failure" ? poolBoundary.created() : api.pods.size).toBe(
					mode === "image-failure" ? 4 : 1,
				),
			);
			if (mode === "full") expect(poolBoundary.created()).toBe(0);
			if (mode === "volume-failure") expect(errors).toEqual(["volume"]);
		} finally {
			await preparation.stop();
		}
	});
});

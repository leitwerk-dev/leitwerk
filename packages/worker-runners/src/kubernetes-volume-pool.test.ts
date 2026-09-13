import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKubernetesVolumePool, POOL_LABEL } from "./kubernetes-volume-pool.js";
import type { PoolObject, PoolStorageClass, VolumePoolApi } from "./kubernetes-volume-pool-api.js";

const signal = new AbortController().signal;

/** Kubernetes boundary fake; controllers and binding transitions remain explicit in each test. */
class PoolApi implements VolumePoolApi {
	classes = new Map<string, PoolStorageClass>();
	objects = new Map<string, PoolObject>();
	operations: string[] = [];
	constructor() {
		this.classes.set("storage", {
			metadata: {
				name: "storage",
				uid: "source",
				annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
			},
			provisioner: "csi.example.org",
			parameters: { type: "fast" },
			reclaimPolicy: "Delete",
			volumeBindingMode: "WaitForFirstConsumer",
			allowVolumeExpansion: true,
			mountOptions: ["discard"],
			allowedTopologies: [{ matchLabelExpressions: [{ key: "zone", values: ["a"] }] }],
		});
	}
	async getStorageClass(name: string) {
		return structuredClone(this.classes.get(name) ?? null);
	}
	async listStorageClasses(selector: string) {
		return structuredClone([...this.classes.values()].filter((value) => matches(value, selector)));
	}
	async createStorageClass(value: PoolStorageClass) {
		this.classes.set(
			value.metadata.name,
			structuredClone({ ...value, metadata: { ...value.metadata, uid: randomUUID() } }),
		);
	}
	async deleteStorageClass(value: PoolStorageClass) {
		this.classes.delete(value.metadata.name);
	}
	async list(kind: string, namespace: string, selector: string) {
		return structuredClone(
			[...this.objects.entries()]
				.filter(
					([key, value]) => key.startsWith(`${kind}/${namespace}/`) && matches(value, selector),
				)
				.map(([, value]) => value),
		);
	}
	async get(kind: string, namespace: string, name: string) {
		return structuredClone(this.objects.get(`${kind}/${namespace}/${name}`) ?? null);
	}
	async create(kind: string, namespace: string, value: PoolObject) {
		this.objects.set(
			`${kind}/${namespace}/${value.metadata.name}`,
			structuredClone({
				...value,
				metadata: { ...value.metadata, uid: randomUUID(), resourceVersion: "1" },
			}),
		);
	}
	async delete(kind: string, namespace: string, value: PoolObject) {
		expect(this.objects.get(`${kind}/${namespace}/${value.metadata.name}`)?.metadata.uid).toBe(
			value.metadata.uid,
		);
		this.operations.push(`delete ${kind}`);
		this.objects.delete(`${kind}/${namespace}/${value.metadata.name}`);
	}
	async patchVolume(value: PoolObject, operations: Array<Record<string, unknown>>) {
		const current = this.objects.get(`persistentvolumes//${value.metadata.name}`);
		if (
			!current ||
			current.metadata.uid !== value.metadata.uid ||
			current.metadata.resourceVersion !== value.metadata.resourceVersion
		)
			throw new Error("conflict");
		for (const operation of operations) {
			const path = String(operation.path).slice(1).split("/");
			const key = path.pop() ?? "";
			let parent = current as unknown as Record<string, unknown>;
			for (const part of path) parent = parent[part] as Record<string, unknown>;
			if (operation.op === "test") expect(parent[key]).toEqual(operation.value);
			else if (operation.op === "remove") delete parent[key];
			else parent[key] = structuredClone(operation.value);
			this.operations.push(`${operation.op} ${operation.path}`);
		}
		current.metadata.resourceVersion = String(Number(current.metadata.resourceVersion) + 1);
	}
}
function matches(value: { metadata: PoolObject["metadata"] }, selector: string) {
	const [key, id] = selector.split("=");
	return value.metadata.labels?.[key] === id;
}
function pool(api: PoolApi, count = 1) {
	return createKubernetesVolumePool({
		api,
		namespace: "server",
		count,
		storageClassName: "storage",
		size: "20Gi",
		accessModes: ["ReadWriteOnce"],
		image: "worker:1",
	});
}
async function provision(api: PoolApi, source: Record<string, unknown>) {
	const controller = pool(api);
	await controller.reconcile(signal); // staging class
	await controller.reconcile(signal); // staging claim
	await controller.reconcile(signal); // WFFC consumer
	const claim = [...api.objects.values()].find((value) => value.kind === "PersistentVolumeClaim");
	const pod = [...api.objects.values()].find((value) => value.kind === "Pod");
	if (!claim || !pod) throw new Error("Missing preparation resources");
	claim.spec.volumeName = "volume";
	pod.status = { phase: "Succeeded" };
	const pv: PoolObject = {
		metadata: {
			name: "volume",
			uid: "volume-uid",
			resourceVersion: "1",
			annotations: { "pv.kubernetes.io/provisioned-by": "csi.example.org" },
		},
		spec: {
			...source,
			storageClassName: claim.metadata.name,
			persistentVolumeReclaimPolicy: "Delete",
			capacity: { storage: "20Gi" },
			accessModes: ["ReadWriteOnce"],
			claimRef: { uid: claim.metadata.uid, namespace: "server", name: claim.metadata.name },
			nodeAffinity: {
				required: {
					nodeSelectorTerms: [
						{ matchExpressions: [{ key: "zone", operator: "In", values: ["a"] }] },
					],
				},
			},
		},
		status: { phase: "Bound" },
	};
	api.objects.set("persistentvolumes//volume", pv);
	return { pv, claim, pod };
}

const sources = [
	{
		csi: {
			driver: "csi.example.org",
			volumeHandle: "opaque-handle",
			fsType: "ext4",
			volumeAttributes: { secretless: "attribute" },
		},
	},
	{ local: { path: "/provided/by/driver" } },
];

describe("Kubernetes volume pre-provisioning", () => {
	it.each(
		sources,
	)("preserves native storage and restarts safely through release: %j", async (source) => {
		const api = new PoolApi();
		const { pv, claim, pod } = await provision(api, source);
		const original = structuredClone(pv.spec);
		expect(pod.spec.automountServiceAccountToken).toBe(false);
		expect(pod.spec.containers).toEqual([expect.not.objectContaining({ env: expect.anything() })]);
		await pool(api).reconcile(signal); // retain before deleting anything
		expect(pv.spec.persistentVolumeReclaimPolicy).toBe("Retain");
		expect(api.operations.some((op) => op.startsWith("delete"))).toBe(false);
		await pool(api).reconcile(signal); // Pod disappears first
		expect(await api.get("persistentvolumeclaims", "server", claim.metadata.name)).not.toBeNull();
		await pool(api).reconcile(signal); // then PVC
		expect(pv.spec.claimRef?.uid).toBe(claim.metadata.uid);
		pv.status = { phase: "Released" };
		await pool(api).reconcile(signal); // unbind
		expect(pv.spec.claimRef).toBeUndefined();
		await pool(api).reconcile(signal); // stale Released status cannot restore Delete
		expect(pv.spec.persistentVolumeReclaimPolicy).toBe("Retain");
		pv.status = { phase: "Available" };
		await pool(api).reconcile(signal); // delete temporary class
		await pool(api).reconcile(signal); // publish
		expect(pv.spec).toEqual({ ...original, claimRef: undefined, storageClassName: "storage" });
		expect(api.classes.size).toBe(1);
		await pool(api).reconcile(signal);
		expect(api.classes.size).toBe(1); // ready pool is full
		pv.spec.claimRef = { uid: "process-claim", namespace: "process", name: "state" };
		pv.status = { phase: "Released" }; // even rapid process completion must never recycle
		await pool(api).reconcile(signal);
		expect(pv.spec.claimRef.uid).toBe("process-claim");
		expect(pv.metadata.labels?.[POOL_LABEL]).toBeUndefined();
		expect(api.classes.size).toBe(2); // replenish with a new allocation
	});

	it("clones provisioner settings without copying default-class metadata", async () => {
		const api = new PoolApi();
		await pool(api).reconcile(signal);
		const staged = [...api.classes.values()].find((value) => value.metadata.name !== "storage");
		expect(staged).toMatchObject({
			...api.classes.get("storage"),
			metadata: {
				name: expect.stringMatching(/^lw-volume-/),
				uid: expect.any(String),
				annotations: { "leitwerk.dev/preparation-size": "20Gi" },
			},
		});
		expect(
			staged?.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"],
		).toBeUndefined();
	});

	it("count zero completes in-flight preparation without refilling", async () => {
		const api = new PoolApi();
		const { pv } = await provision(api, sources[0]);
		await pool(api, 0).reconcile(signal);
		expect(pv.spec.persistentVolumeReclaimPolicy).toBe("Retain");
		const empty = new PoolApi();
		await pool(empty, 0).reconcile(signal);
		expect(empty.classes.size).toBe(1);
	});

	it("refuses a preparation Pod replaced by another owner", async () => {
		const api = new PoolApi();
		const { pv, pod } = await provision(api, sources[0]);
		await pool(api).reconcile(signal);
		pod.metadata.ownerReferences = [{ uid: "someone-else" }];
		await expect(pool(api).reconcile(signal)).rejects.toThrow("ownership mismatch");
		expect(pv.spec.claimRef).toBeDefined();
		expect(api.operations.some((op) => op.startsWith("delete"))).toBe(false);
	});

	it("retries failed preparation with the same PVC", async () => {
		const api = new PoolApi();
		const { pod, claim } = await provision(api, sources[0]);
		pod.status = { phase: "Failed" };
		await pool(api).reconcile(signal);
		await pool(api).reconcile(signal);
		expect((await api.get("pods", "server", claim.metadata.name))?.metadata.uid).not.toBe(
			pod.metadata.uid,
		);
		expect(
			(await api.get("persistentvolumeclaims", "server", claim.metadata.name))?.metadata.uid,
		).toBe(claim.metadata.uid);
		expect(api.classes.size).toBe(2);
	});
});

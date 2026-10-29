import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKubernetesVolumePool, POOL_LABEL } from "./kubernetes-volume-pool.js";
import type { PoolObject, PoolStorageClass, VolumePoolApi } from "./kubernetes-volume-pool-api.js";
import { retireKubernetesProcessVolume } from "./kubernetes-volume-retirement.js";

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

describe("process volume retirement", () => {
	async function setup() {
		const api = new PoolApi();
		const { claim, pod, pv } = await provision(api, sources[0]);
		claim.metadata.labels = {
			"leitwerk.dev/managed-by": "leitwerk",
			"leitwerk.dev/component": "process-volume",
			"leitwerk.dev/instance-id": "instance",
		};
		pv.spec.persistentVolumeReclaimPolicy = "Retain";
		const retire = (
			reason?: "retention-expired" | "process-deleted",
			reclaimBackingStorage?:
				| { lifecycleStatus: "completed" | "aborted"; closedAt: string }
				| "process-deleted",
		) =>
			retireKubernetesProcessVolume({
				api,
				namespace: "server",
				name: claim.metadata.name,
				instanceId: "instance",
				signal,
				reason,
				reclaimBackingStorage,
			});
		return { api, claim, pod, pv, retire };
	}
	it.each([
		"retention-expired",
		"process-deleted",
	] as const)("records queryable exact ownership before %s removes a Retain claim", async (reason) => {
		const { pv, claim, retire, api } = await setup();
		await retire(reason);
		expect(pv.metadata.labels).toMatchObject({
			"leitwerk.dev/managed-by": "leitwerk",
			"leitwerk.dev/component": "process-volume",
			"leitwerk.dev/instance-id": "instance",
		});
		expect(JSON.parse(pv.metadata.annotations?.["leitwerk.dev/retirement"] ?? "{}")).toMatchObject({
			claimUid: claim.metadata.uid,
			volumeUid: pv.metadata.uid,
			reason,
		});
		expect(pv.spec.persistentVolumeReclaimPolicy).toBe("Retain");
		await retire(); // controller restart/already released is a no-op
		expect(api.operations.filter((op) => op === "delete persistentvolumeclaims")).toHaveLength(1);
	});
	it.each([
		"completed",
		"aborted",
	] as const)("arms CSI reclamation for %s before deleting the claim and ends pool ownership", async (lifecycleStatus) => {
		const { api, claim, pv, retire } = await setup();
		const storageClass = api.classes.get("storage");
		if (!storageClass) throw new Error("missing StorageClass");
		storageClass.reclaimPolicy = "Retain";
		pv.metadata.labels = { [POOL_LABEL]: pool(api).poolId };
		const authorization = { lifecycleStatus, closedAt: "2026-01-01T00:00:00Z" };
		const originalDelete = api.delete.bind(api);
		api.delete = async (kind, namespace, value) => {
			if (kind === "persistentvolumeclaims") {
				expect(pv.spec.persistentVolumeReclaimPolicy).toBe("Delete");
				expect(pv.metadata.labels?.[POOL_LABEL]).toBeUndefined();
				expect(
					JSON.parse(pv.metadata.annotations?.["leitwerk.dev/retirement"] ?? "{}").reclamation,
				).toEqual({ policy: "terminal-process", ...authorization });
			}
			await originalDelete(kind, namespace, value);
		};
		await retire("retention-expired", authorization);
		expect(await api.get("persistentvolumeclaims", "server", claim.metadata.name)).toBeNull();
		await pool(api).reconcile(signal);
		expect(pv.spec.persistentVolumeReclaimPolicy).toBe("Delete");
		expect(api.classes.get("storage")?.reclaimPolicy).toBe("Retain");
	});

	it("requires explicit process deletion before applying deletion authorization", async () => {
		const { api, pv, retire } = await setup();
		await expect(retire("retention-expired", "process-deleted")).rejects.toThrow(
			"process deletion request",
		);
		expect(api.operations).toEqual([]);
		await retire("process-deleted", "process-deleted");
		expect(pv.spec.persistentVolumeReclaimPolicy).toBe("Delete");
		expect(
			JSON.parse(pv.metadata.annotations?.["leitwerk.dev/retirement"] ?? "{}").reclamation.policy,
		).toBe("process-deletion");
	});

	it("restarts safely after policy patch succeeds but PVC deletion fails", async () => {
		const { api, claim, pv, retire } = await setup();
		const originalDelete = api.delete.bind(api);
		api.delete = async () => {
			throw new Error("transport failed");
		};
		const authorization = {
			lifecycleStatus: "completed" as const,
			closedAt: "2026-01-01T00:00:00Z",
		};
		await expect(retire("retention-expired", authorization)).rejects.toThrow("transport failed");
		expect(pv.spec.persistentVolumeReclaimPolicy).toBe("Delete");
		expect(await api.get("persistentvolumeclaims", "server", claim.metadata.name)).not.toBeNull();
		api.delete = originalDelete;
		await retire("retention-expired", authorization);
		await retire("retention-expired", authorization);
		expect(
			api.operations.filter((operation) => operation === "delete persistentvolumeclaims"),
		).toHaveLength(1);
	});

	it("keeps an unbound claim until its backing identity can be audited", async () => {
		const { api, claim, retire } = await setup();
		delete claim.spec.volumeName;
		await expect(
			retire("retention-expired", {
				lifecycleStatus: "completed",
				closedAt: "2026-01-01T00:00:00Z",
			}),
		).rejects.toThrow("still provisioning");
		expect(
			(await api.get("persistentvolumeclaims", "server", claim.metadata.name))?.metadata.uid,
		).toBe(claim.metadata.uid);
		expect(api.operations).toEqual([]);
	});

	it.each([
		"non-CSI",
		"static CSI",
	])("refuses automatic reclamation of %s storage", async (mode) => {
		const { api, pv, retire } = await setup();
		if (mode === "non-CSI") delete pv.spec.csi;
		else delete pv.metadata.annotations?.["pv.kubernetes.io/provisioned-by"];
		await expect(
			retire("retention-expired", {
				lifecycleStatus: "completed",
				closedAt: "2026-01-01T00:00:00Z",
			}),
		).rejects.toThrow("dynamically provisioned CSI");
		expect(api.operations).toEqual([]);
	});

	it.each([
		"invalid",
		"2099-01-01T00:00:00Z",
	])("refuses invalid or unexpired closure: %s", async (closedAt) => {
		const { api, retire } = await setup();
		await expect(
			retire("retention-expired", { lifecycleStatus: "completed", closedAt }),
		).rejects.toThrow("closed terminal process");
		expect(api.operations).toEqual([]);
	});

	it("refuses live references and foreign ownership", async () => {
		const { retire, pod, claim, api } = await setup();
		const authorization = {
			lifecycleStatus: "completed" as const,
			closedAt: "2026-01-01T00:00:00Z",
		};
		pod.status = { phase: "Pending" };
		await expect(retire("retention-expired", authorization)).rejects.toThrow("live Pod");
		pod.status = { phase: "Succeeded" };
		claim.metadata.labels = {};
		await expect(retire("retention-expired", authorization)).rejects.toThrow("foreign");
		expect(api.operations).toEqual([]);
	});
	it.each([
		{ "leitwerk.dev/managed-by": "external-owner", "leitwerk.dev/instance-id": "instance" },
		{ "leitwerk.dev/managed-by": "leitwerk", "leitwerk.dev/instance-id": "another-process" },
	])("never overwrites conflicting PV ownership: %j", async (labels) => {
		const { retire, pv, api } = await setup();
		pv.metadata.labels = labels;
		await expect(
			retire("retention-expired", {
				lifecycleStatus: "completed",
				closedAt: "2026-01-01T00:00:00Z",
			}),
		).rejects.toThrow("ambiguous claim ownership");
		expect(api.operations).toEqual([]);
	});
	it("leaves the claim intact after partial annotation failure", async () => {
		const { retire, api, claim } = await setup();
		api.patchVolume = async () => {
			throw new Error("conflict");
		};
		await expect(retire()).rejects.toThrow("conflict");
		expect(await api.get("persistentvolumeclaims", "server", claim.metadata.name)).not.toBeNull();
	});
});

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
		await pool(api, 0).reconcile(signal); // remove preparation Pod
		await pool(api, 0).reconcile(signal); // remove preparation PVC
		pv.status = { phase: "Released" };
		await pool(api, 0).reconcile(signal); // unbind
		expect(pv.spec.claimRef).toBeUndefined();
		pv.status = { phase: "Available" };
		await pool(api, 0).reconcile(signal); // remove staging class
		await pool(api, 0).reconcile(signal); // publish
		expect(pv.spec).toMatchObject({
			storageClassName: "storage",
			persistentVolumeReclaimPolicy: "Delete",
		});
		await pool(api, 0).reconcile(signal); // do not replenish after preparation finishes
		expect([...api.classes.keys()]).toEqual(["storage"]);
		expect([...api.objects.keys()]).toEqual(["persistentvolumes//volume"]);
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

	it("keeps a failed receipt and PVC across restarts without automatic churn", async () => {
		const api = new PoolApi();
		const { pod, claim } = await provision(api, sources[0]);
		pod.status = { phase: "Failed" };
		for (let attempt = 0; attempt < 20; attempt++) {
			await expect(pool(api).reconcile(signal)).rejects.toThrow("Volume pool preparation blocked");
		}
		const replacement = await api.get("pods", "server", claim.metadata.name);
		expect(replacement?.metadata.uid).toBe(pod.metadata.uid);
		expect(api.operations).not.toContain("delete pods");
		expect(
			(await api.get("persistentvolumeclaims", "server", claim.metadata.name))?.metadata.uid,
		).toBe(claim.metadata.uid);
		expect(api.classes.size).toBe(2);
		// Explicit operator retry after fixing storage reuses the claim.
		await api.delete("pods", "server", pod);
		await pool(api).reconcile(signal);
		expect((await api.get("pods", "server", claim.metadata.name))?.metadata.uid).not.toBe(
			pod.metadata.uid,
		);
	});

	it.each([
		"Pending",
		"Running",
	])("bounds stalled %s preparation without allocating around it", async (phase) => {
		const api = new PoolApi();
		const { claim, pod } = await provision(api, sources[0]);
		claim.metadata.creationTimestamp = new Date(Date.now() - 20 * 60_000).toISOString();
		pod.status = {
			phase,
			conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }],
		};
		for (let attempt = 0; attempt < 10; attempt++) {
			await expect(pool(api).reconcile(signal)).rejects.toThrow(/age=12\d\ds.*Unschedulable/);
		}
		expect(pod.spec.activeDeadlineSeconds).toBe(900);
		expect(api.classes.size).toBe(2);
		expect(api.operations).toEqual([]);
		pod.status = { phase: "Succeeded" };
		await pool(api).reconcile(signal);
		expect(api.objects.get("persistentvolumes//volume")?.spec.persistentVolumeReclaimPolicy).toBe(
			"Retain",
		);
	});
});

import { describe, expect, it } from "vitest";
import { createVolumePoolApi } from "./kubernetes-volume-pool-api.js";

type Request = Parameters<typeof createVolumePoolApi>[0];
const signal = new AbortController().signal;

function boundary(responses: Array<{ status: number; body: unknown }>) {
	const calls: Parameters<Request>[0][] = [];
	const request: Request = async <T>(input: Parameters<Request>[0]) => {
		calls.push(input);
		input.signal?.throwIfAborted();
		const response = responses.shift();
		if (!response) throw new Error("Unexpected request");
		return { status: response.status, body: response.body as T };
	};
	return { api: createVolumePoolApi(request), calls };
}

describe("volume pool Kubernetes API", () => {
	it("treats a 404 Status body as absence", async () => {
		const { api } = boundary([
			{ status: 404, body: { kind: "Status" } },
			{ status: 404, body: { kind: "Status" } },
		]);
		expect(await api.get("pods", "server", "preparation", signal)).toBeNull();
		expect(await api.getStorageClass("missing", signal)).toBeNull();
	});
	it("paginates labelled volumes and retains the selector", async () => {
		const { api, calls } = boundary([
			{
				status: 200,
				body: { items: [{ metadata: { name: "a" } }], metadata: { continue: "next/token" } },
			},
			{ status: 200, body: { items: [{ metadata: { name: "b" } }] } },
		]);
		expect(
			(await api.list("persistentvolumes", "", "pool=one", signal)).map(
				(value) => value.metadata.name,
			),
		).toEqual(["a", "b"]);
		expect(calls[1].path).toContain("labelSelector=pool%3Done");
		expect(calls[1].path).toContain("continue=next%2Ftoken");
	});
	it("uses compare-and-swap patches and UID-preconditioned deletion", async () => {
		const { api, calls } = boundary([
			{ status: 200, body: null },
			{ status: 200, body: null },
		]);
		const volume = { metadata: { name: "volume", uid: "uid", resourceVersion: "42" }, spec: {} };
		await api.patchVolume(volume, [{ op: "remove", path: "/spec/claimRef" }], signal);
		expect(calls[0].body).toEqual([
			{ op: "test", path: "/metadata/uid", value: "uid" },
			{ op: "test", path: "/metadata/resourceVersion", value: "42" },
			{ op: "remove", path: "/spec/claimRef" },
		]);
		expect(calls[0].contentType).toBe("application/json-patch+json");
		await api.delete("pods", "server", volume, signal);
		expect(calls[1].body).toMatchObject({ preconditions: { uid: "uid" } });
	});
	it("rejects missing identities and propagates cancellation", async () => {
		const { api, calls } = boundary([]);
		await expect(
			api.patchVolume({ metadata: { name: "pv" }, spec: {} }, [], signal),
		).rejects.toThrow("identity");
		expect(calls).toEqual([]);
		await expect(api.listStorageClasses("pool=one", AbortSignal.abort())).rejects.toThrow();
	});
});

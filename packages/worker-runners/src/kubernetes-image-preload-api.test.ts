import { describe, expect, it } from "vitest";
import { createImagePreloadApi } from "./kubernetes-image-preload-api.js";

type Request = Parameters<typeof createImagePreloadApi>[0];
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
	return { api: createImagePreloadApi(request), calls };
}
describe("image preparation Kubernetes boundary", () => {
	it("paginates nodes and preparation Pods and treats a 404 as absence", async () => {
		const { api, calls } = boundary([
			{
				status: 200,
				body: { items: [{ metadata: { name: "a" } }], metadata: { continue: "next/token" } },
			},
			{ status: 200, body: { items: [{ metadata: { name: "b" } }] } },
			{ status: 200, body: { items: [] } },
			{ status: 404, body: { kind: "Status" } },
		]);
		expect((await api.listNodes(signal)).map((node) => node.metadata.name)).toEqual(["a", "b"]);
		expect(calls[1].path).toContain("continue=next%2Ftoken");
		await api.listPods("server", "pool=one", signal);
		expect(calls[2].path).toContain("labelSelector=pool%3Done");
		expect(await api.getPod("server", "receipt", signal)).toBeNull();
	});
	it("uses UID deletion preconditions and bounded cancellable requests", async () => {
		const { api, calls } = boundary([{ status: 202, body: null }]);
		await expect(
			api.deletePod("server", { metadata: { name: "receipt" }, spec: {} }, signal),
		).rejects.toThrow("identity");
		expect(calls).toEqual([]);
		await api.deletePod(
			"server",
			{ metadata: { name: "receipt", uid: "original" }, spec: {} },
			signal,
		);
		expect(calls[0].body).toMatchObject({ preconditions: { uid: "original" } });
		await expect(api.listNodes(AbortSignal.abort())).rejects.toThrow();
	});
});

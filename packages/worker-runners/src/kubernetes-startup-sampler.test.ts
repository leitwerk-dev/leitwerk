import { afterEach, expect, it, vi } from "vitest";
import { FakeKubernetesApiClient } from "./kubernetes-api-client.js";
import { sampleKubernetesStartup } from "./kubernetes-startup-sampler.js";
import { buildWorkerUnitLabels } from "./worker-labels.js";

afterEach(() => vi.useRealTimers());
it("cancels pending sampling without waiting for a request to settle", async () => {
	vi.useFakeTimers();
	const client = new FakeKubernetesApiClient();
	let signal: AbortSignal | undefined;
	const getPod = vi.spyOn(client, "getPod").mockImplementation((_name, _namespace, options) => {
		signal = options?.signal;
		return new Promise(() => {});
	});
	const sampler = sampleKubernetesStartup(client, { report() {}, observe() {} }, "ns", "pvc");
	sampler.attachPod({ name: "pod", instanceId: "p", workerId: "w" });
	await vi.advanceTimersByTimeAsync(500);
	sampler.stop();
	expect(signal?.aborted).toBe(true);
	await vi.advanceTimersByTimeAsync(10000);
	expect(getPod).toHaveBeenCalledTimes(1);
});
it("ignores other UIDs and sidecars, accepts terminated start, and does not invent a cached pull", async () => {
	vi.useFakeTimers();
	const client = new FakeKubernetesApiClient();
	vi.spyOn(client, "getPod").mockResolvedValue({
		name: "pod",
		namespace: "ns",
		uid: "uid",
		labels: buildWorkerUnitLabels({ instanceId: "p", workerId: "w", serverEpoch: "e" }),
		phase: "Running",
		containerStartedAt: "2026-09-11T10:00:02Z",
	});
	client.recordPodEvent("pod", "ns", {
		objectUid: "wrong",
		fieldPath: "spec.containers{worker}",
		reason: "Pulling",
		firstTimestamp: "2026-09-11T10:00:00Z",
	});
	client.recordPodEvent("pod", "ns", {
		objectUid: "uid",
		fieldPath: "spec.containers{sidecar}",
		reason: "Pulling",
		firstTimestamp: "2026-09-11T10:00:00Z",
	});
	client.recordPodEvent("pod", "ns", {
		objectUid: "uid",
		fieldPath: "spec.containers{worker}",
		reason: "Pulled",
		message: "Container image already present on machine",
		firstTimestamp: "2026-09-11T10:00:01Z",
	});
	const observe = vi.fn();
	const sampler = sampleKubernetesStartup(client, { report() {}, observe }, "ns", "pvc");
	sampler.attachPod({ name: "pod", instanceId: "p", workerId: "w" });
	await vi.advanceTimersByTimeAsync(600);
	sampler.stop();
	expect(observe.mock.calls.map((c) => c[0].milestone)).toEqual([
		"container_started",
		"image_cached",
	]);
});

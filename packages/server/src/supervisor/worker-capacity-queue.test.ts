import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerCapacityQueue } from "./worker-capacity-queue.js";

afterEach(() => vi.useRealTimers());

function fixture(limit = 1) {
	vi.useFakeTimers();
	const active = new Set<string>();
	const current = new Map<string, string>();
	const start = vi.fn(async (id: string) => {
		active.add(id);
		return id;
	});
	const onQueued = vi.fn();
	const onFailure = vi.fn();
	const queue = createWorkerCapacityQueue({
		limit,
		activeCount: () => active.size,
		isCurrent: (id, token) => current.get(id) === token,
		start,
		onQueued,
		onFailure,
	});
	const request = (id: string, token = id) => {
		current.set(id, token);
		return queue.request(id, token);
	};
	return { queue, active, current, start, onQueued, onFailure, request };
}

describe("worker capacity queue", () => {
	it("admits FIFO automatically when slots open and deduplicates queued requests", async () => {
		const f = fixture();
		await f.request("one");
		expect(await f.request("two")).toBeUndefined();
		await f.request("two");
		await f.request("three");
		expect(f.onQueued.mock.calls.map(([id]) => id)).toEqual(["two", "three"]);
		f.active.delete("one");
		f.queue.wake();
		await vi.runAllTimersAsync();
		expect(f.start.mock.calls.map(([id]) => id)).toEqual(["one", "two"]);
		f.active.delete("two");
		f.queue.wake();
		await vi.runAllTimersAsync();
		expect(f.start.mock.calls.map(([id]) => id)).toEqual(["one", "two", "three"]);
		await f.queue.stop();
	});

	it("reserves capacity during asynchronous allocation, including concurrent requests", async () => {
		const f = fixture();
		const allocation = Promise.withResolvers<string>();
		f.start.mockImplementationOnce(() => allocation.promise);
		const first = f.request("one");
		await f.request("two");
		await vi.runAllTimersAsync();
		expect(f.start).toHaveBeenCalledTimes(1);
		f.active.add("one");
		allocation.resolve("one");
		await first;
		await vi.runAllTimersAsync();
		expect(f.start).toHaveBeenCalledTimes(1);
		f.active.clear();
		f.queue.wake();
		await vi.runAllTimersAsync();
		expect(f.start).toHaveBeenCalledTimes(2);
		await f.queue.stop();
	});

	it("skips stopped or superseded starts and preserves the next eligible process", async () => {
		const f = fixture();
		await f.request("one");
		await f.request("stopped");
		await f.request("stale");
		await f.request("next");
		await f.queue.cancel("stopped");
		f.current.set("stale", "replacement");
		f.active.clear();
		f.queue.wake();
		await vi.runAllTimersAsync();
		expect(f.start.mock.calls.map(([id]) => id)).toEqual(["one", "next"]);
		await f.queue.stop();
	});

	it("releases failed reservations and continues after a queued startup fails", async () => {
		const f = fixture();
		await f.request("one");
		await f.request("broken");
		await f.request("next");
		f.start.mockRejectedValueOnce(new Error("allocation failed"));
		f.active.clear();
		f.queue.wake();
		await vi.runAllTimersAsync();
		expect(f.onFailure).toHaveBeenCalledWith("broken", expect.any(Error));
		expect(f.active.has("next")).toBe(true);
		await f.queue.stop();
	});

	it("discards pending work on shutdown and rejects new requests", async () => {
		const f = fixture();
		await f.request("one");
		await f.request("two");
		await f.queue.stop();
		f.active.clear();
		f.queue.wake();
		await vi.runAllTimersAsync();
		expect(f.start).toHaveBeenCalledTimes(1);
		await expect(f.request("three")).rejects.toThrow("shutting down");
	});
});

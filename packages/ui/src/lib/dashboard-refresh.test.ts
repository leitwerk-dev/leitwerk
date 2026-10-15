import type { DashboardResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import { describe, expect, it, vi } from "vitest";
import { createDashboardRefresh, type DashboardLoadState } from "./dashboard-refresh.js";

const data = { generatedAt: "2026-10-14T12:00:00Z" } as DashboardResponseBody;

describe("dashboard refresh", () => {
	it("coalesces overlapping requests and retains the snapshot on a refresh failure", async () => {
		const pending = Promise.withResolvers<DashboardResponseBody>();
		const fetch = vi.fn(() => pending.promise);
		const states: DashboardLoadState[] = [];
		const loader = createDashboardRefresh(fetch, (state) => states.push(state));
		const first = loader.refresh();
		expect(loader.refresh()).toBe(first);
		await Promise.resolve();
		expect(fetch).toHaveBeenCalledTimes(1);
		pending.resolve(data);
		await first;
		expect(states.at(-1)).toEqual({ data, loading: false, error: null });
		fetch.mockRejectedValueOnce(new Error("offline"));
		await loader.refresh();
		expect(states.at(-1)).toMatchObject({
			data,
			loading: false,
			error: expect.stringContaining("Try again"),
		});
	});
	it("aborts on disposal and discards late responses", async () => {
		const pending = Promise.withResolvers<DashboardResponseBody>();
		let signal!: AbortSignal;
		const states: DashboardLoadState[] = [];
		const loader = createDashboardRefresh(
			(requestSignal) => {
				signal = requestSignal;
				return pending.promise;
			},
			(state) => states.push(state),
		);
		const request = loader.refresh();
		await Promise.resolve();
		loader.dispose();
		expect(signal.aborted).toBe(true);
		pending.resolve(data);
		await request;
		expect(states).toHaveLength(1);
		await loader.refresh();
		expect(states).toHaveLength(1);
	});
});

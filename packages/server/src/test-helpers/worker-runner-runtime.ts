import { vi } from "vitest";
import type { AppOptions } from "../app.js";

export function fakeWorkerRunnerRuntime(): NonNullable<AppOptions["workerRunnerRuntime"]> {
	return {
		runner: {
			start: vi.fn(async () => {
				throw new Error("unexpected worker start");
			}),
			stop: vi.fn(async () => {}),
			list: vi.fn(async () => []),
			adopt: vi.fn(async () => {
				throw new Error("unexpected worker adoption");
			}),
		},
		exporter: {
			prepare: vi.fn(async () => {
				throw new Error("unexpected process state export");
			}),
			reconcile: vi.fn(async () => {}),
		},
		volume: {
			ensure: vi.fn(async (instanceId: string) => ({
				instanceId,
				id: `vol-${instanceId}`,
				mountPath: "/workspace",
			})),
			release: vi.fn(async () => {}),
			deleteProcessResources: vi.fn(async () => {}),
		},
	};
}

import type { WorkerToServerMessage } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it, vi } from "vitest";
import type { WorkerIpc } from "../ipc.js";
import type { PiTreeHandleFactory } from "../pi-adapter.js";
import type { RunRootGitOps } from "../workspace/run-root.js";
import { createWorkerRuntime, nodeWorkerRuntimeScheduler } from "./index.js";

describe("worker runtime interface", () => {
	it("starts at transport readiness and exposes only lifecycle commands", async () => {
		const outgoing: WorkerToServerMessage[] = [];
		const transport: WorkerIpc = {
			send: (message) => outgoing.push(message),
			onMessage() {},
			onError() {},
			onConnect() {},
			start: vi.fn(),
			stop: vi.fn(),
		};
		const runtime = createWorkerRuntime({
			config: { instanceId: "proc_1", workerId: "worker_1" },
			adapters: {
				transport,
				sessionSnapshots: {
					async uploadSnapshot() {
						return { kind: "uploaded", bytes: 0 };
					},
				},
				resultImageTools: { create: () => null },
				piFactory: {} as PiTreeHandleFactory,
				gitOps: {} as RunRootGitOps,
				scheduler: nodeWorkerRuntimeScheduler,
				exit: vi.fn(),
			},
		});

		await runtime.start();

		expect(transport.start).toHaveBeenCalledOnce();
		expect(outgoing.map((message) => message.type)).toEqual(["worker.hello"]);
		expect(Object.keys(runtime).sort()).toEqual(["start", "stop"]);
	});
});

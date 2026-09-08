import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { DEFAULT_SESSION_TRANSFER_LIMITS } from "@leitwerk-dev/session-transfer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createHelperProcessStateExporter,
	type ExportHelperUnit,
} from "./helper-process-state-exporter.js";
import { createExportTestFixture } from "./session-transfer.test-helper.js";

class FakeExportHelper implements ExportHelperUnit {
	readonly exit = Promise.withResolvers<{ exitCode: number | null }>();
	removeCalls = 0;
	removed = false;
	failures = 0;
	removalGate: Promise<void> | undefined;

	wait() {
		return this.exit.promise;
	}

	async remove(): Promise<void> {
		this.removeCalls += 1;
		await this.removalGate;
		if (this.failures > 0) {
			this.failures -= 1;
			throw new Error("Temporary runner API failure");
		}
		this.removed = true;
		this.exit.resolve({ exitCode: 0 });
	}
}

afterEach(() => {
	vi.useRealTimers();
});

async function fixture(helper: FakeExportHelper) {
	const { manifest } = createExportTestFixture();
	const upload = new PassThrough();
	upload.on("error", () => undefined);
	const exporter = createHelperProcessStateExporter({
		volume: {
			async ensure(instanceId) {
				return { instanceId, id: "retained-volume", mountPath: "/state" };
			},
		},
		helperRelays: {
			create: () => ({
				exportId: "exp-1",
				credential: "test-export-credential",
				waitForPreflight: async () => ({
					manifest,
					preflight: { entriesTotal: 3, logicalBytesTotal: 10 },
				}),
				activateStream: () => upload,
				fail: (error) => upload.destroy(error),
			}),
		},
		launch: async () => helper,
		async reconcileHelpers() {},
	});
	const controller = new AbortController();
	const prepared = await exporter.prepare({
		instanceId: manifest.instanceId,
		manifest,
		limits: DEFAULT_SESSION_TRANSFER_LIMITS,
		signal: controller.signal,
	});
	const stream = prepared.stream({});
	stream.resume();
	return { controller, stream, upload };
}

describe("export helper cleanup", () => {
	it.each([
		"cancellation",
		"stream completion",
	])("retries a runner removal failure after %s without losing cleanup ownership", async (trigger) => {
		vi.useFakeTimers();
		const helper = new FakeExportHelper();
		helper.failures = 1;
		const { controller, stream, upload } = await fixture(helper);
		if (trigger === "cancellation") {
			controller.abort();
		} else {
			upload.end("archive");
			await finished(stream);
			helper.exit.resolve({ exitCode: 0 });
		}
		await vi.advanceTimersByTimeAsync(0);
		expect(helper.removeCalls).toBe(1);
		expect(helper.removed).toBe(false);

		await vi.runOnlyPendingTimersAsync();
		expect(helper.removeCalls).toBe(2);
		expect(helper.removed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("shares in-flight removal across cancellation, stream closure, and helper exit", async () => {
		vi.useFakeTimers();
		const helper = new FakeExportHelper();
		const gate = Promise.withResolvers<void>();
		helper.removalGate = gate.promise;
		const { controller } = await fixture(helper);
		controller.abort();
		helper.exit.resolve({ exitCode: 1 });
		await vi.advanceTimersByTimeAsync(0);
		expect(helper.removeCalls).toBe(1);
		expect(helper.removed).toBe(false);

		gate.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(helper.removeCalls).toBe(1);
		expect(helper.removed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});

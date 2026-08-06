import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	createInMemoryExternalWriteLog,
	createTestServerSetupCapability,
	setupServerExtensionTest,
} from "./server-extension-test-harness.js";

describe("server extension test harness helpers", () => {
	it("tracks external-write dedup keys in memory", () => {
		const log = createInMemoryExternalWriteLog();
		expect(log.hasDedupKey("abc")).toBe(false);
		log.record({ dedupKey: "abc" });
		expect(log.hasDedupKey("abc")).toBe(true);
		expect([...log.getDedupKeys()]).toEqual(["abc"]);
	});

	it("creates overridable server-setup capabilities", async () => {
		const startProcess = vi.fn(async () => ({ ok: true, process: null }));
		const setup = createTestServerSetupCapability({
			serverBaseUrl: "https://custom.example",
			commands: { startProcess },
		});

		expect(setup.serverBaseUrl).toBe("https://custom.example");
		await setup.commands.startProcess("agt_1", "generate_plan");
		expect(startProcess).toHaveBeenCalledWith("agt_1", "generate_plan");
		expect(setup.commands.abortProcess).toBeTypeOf("function");
	});

	it("wires extension setup and captures lifecycle hooks", async () => {
		const extension: LeitwerkExtensionModule = {
			manifest: { id: "test-extension", version: "0.1.0" },
			setupServer(api) {
				api.onStart(() => {});
				api.onStop(() => {});
			},
		};

		const harness = await setupServerExtensionTest({ modules: [extension] });

		expect(harness.startHooks).toHaveLength(1);
		expect(harness.stopHooks).toHaveLength(1);
		expect(harness.serverSetup.serverBaseUrl).toBe("https://leitwerk.example");
	});
});

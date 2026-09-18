import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it, vi } from "vitest";
import { createIntegrationHarness } from "./integration-harness.js";
import { createTestApp } from "./test-app.js";

describe("shared harness lifecycle", () => {
	it("defers binding and reconciliation until explicit context startup", async () => {
		const started = vi.fn();
		const harness = await createIntegrationHarness({
			listen: false,
			extensionCatalog: buildExtensionCatalogFromModules([
				{
					manifest: { id: "deferred-lifecycle", version: "1.0.0" },
					setupServer(api) {
						api.onStart(started);
					},
				},
			]),
		});
		try {
			expect(harness.address).toBe("");
			expect(harness.ctx.app.server.listening).toBe(false);
			expect(started).not.toHaveBeenCalled();
			const result = await harness.ctx.listen({
				host: "127.0.0.1",
				port: 0,
				useBoundAddressAsBaseUrl: true,
			});
			expect(harness.address).toBe(result.address);
			expect(harness.ctx.isReady()).toBe(true);
			expect(started).toHaveBeenCalledTimes(1);
		} finally {
			await harness.close();
		}
	});
	for (const create of [createIntegrationHarness, createTestApp]) {
		it(`${create.name} starts by default and supports bind-only fixtures`, async () => {
			for (const backgroundServices of [true, false]) {
				const started = vi.fn();
				const stopped = vi.fn();
				const harness = await create({
					backgroundServices,
					extensionCatalog: buildExtensionCatalogFromModules([
						{
							manifest: { id: "harness-lifecycle", version: "1.0.0" },
							setupServer(api) {
								api.onStart(started);
								api.onStop(stopped);
							},
						},
					]),
				});
				try {
					expect(harness.ctx.isReady()).toBe(backgroundServices);
					expect(started).toHaveBeenCalledTimes(backgroundServices ? 1 : 0);
					expect(harness.ctx.config.server.base_url).toBe(harness.address);
					if (backgroundServices) {
						await harness.ctx.listen();
						expect(started).toHaveBeenCalledTimes(1);
					}
				} finally {
					await harness.close();
				}
				expect(stopped).toHaveBeenCalledTimes(1);
			}
		});
		it(`${create.name} cleans up when startup fails`, async () => {
			const stopped = vi.fn();
			await expect(
				create({
					extensionCatalog: buildExtensionCatalogFromModules([
						{
							manifest: { id: "harness-failure", version: "1.0.0" },
							setupServer(api) {
								api.onStart(() => {
									throw new Error("fixture startup failed");
								});
								api.onStop(stopped);
							},
						},
					]),
				}),
			).rejects.toThrow("fixture startup failed");
			expect(stopped).toHaveBeenCalledTimes(1);
		});
	}
});

import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
} from "@leitwerk-dev/process-sdk";
import type { AppContext } from "@leitwerk-dev/server";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";
import { createIntegrationHarness, waitForValue } from "@leitwerk-dev/test-support/integration";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let ctx: AppContext;
let address: string;

const testExtensionCatalog = buildExtensionCatalogFromModules([
	showcaseProcessesExtension,
	{
		manifest: { id: "agents-http-fixture-provider", version: "1.0.0" },
		modelProviders: defineModelProviders((rawConfig) => [
			{
				definition: defineModelProvider({
					id: "fixture",
					parseConfig: () => ({ config: {} }),
					worker: builtinPiProvider("openai"),
					models: () => [{ modelId: "fixture-model", availability: "available" }],
					secrets: () => ({}),
				}),
				rawConfig,
			},
		]),
	},
]);

beforeAll(async () => {
	const harness = await createIntegrationHarness({
		extensionCatalog: testExtensionCatalog,
		configOverride(config) {
			config.pi.model_profiles = [
				{
					id: "fixture",
					provider: "fixture",
					model_id: "fixture-model",
					thinking_level: "off",
				},
			];
		},
	});
	ctx = harness.ctx;
	address = harness.address;
});

afterAll(async () => {
	await ctx.supervisor.detachAll("test_close");
	ctx.app.server.closeIdleConnections?.();
	ctx.app.server.closeAllConnections?.();
	await ctx.app.close();
}, 20_000);

describe("GET /api/processes", () => {
	it("returns empty list initially", async () => {
		const res = await fetch(`${address}/api/processes`);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.processes).toEqual([]);
	});
});

describe("Process lifecycle HTTP routes", () => {
	it("aborts through worker delivery instead of direct lifecycle mutation", async () => {
		const process = ctx.deps.processes.create({
			processId: "single_prompt_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "run_single_prompt",
			externalId: "prompt-120",
		});

		const res = await fetch(`${address}/api/processes/${process.id}/abort`, { method: "POST" });
		expect(res.status).toBe(200);

		await waitForValue(
			() => ctx.deps.processes.getById(process.id),
			(current) => current?.lifecycleStatus === "aborted",
		);
	});

	it("returns 404 for missing process", async () => {
		const res = await fetch(`${address}/api/processes/nonexistent`);
		expect(res.status).toBe(404);
	});
});

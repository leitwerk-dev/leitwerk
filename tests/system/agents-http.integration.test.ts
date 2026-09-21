import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import type { AppContext } from "@leitwerk-dev/server";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import { createIntegrationHarness, waitForValue } from "@leitwerk-dev/test-support/integration";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let ctx: AppContext;
let address: string;

const testExtensionCatalog = buildExtensionCatalogFromModules([
	showcaseProcessesExtension,
	{
		manifest: { id: "agents-http-fixture-provider", version: "1.0.0" },
		modelProviders: fixtureModelProviders({
			id: "fixture",
			modelId: "fixture-model",
			piProvider: "openai",
		}),
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
	await ctx.close();
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

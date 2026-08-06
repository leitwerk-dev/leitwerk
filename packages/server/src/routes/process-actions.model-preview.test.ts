import type {
	ProcessActionModelPreviewLike,
	ProcessModelSelectionPreviewResultLike,
	ProcessModelSelectionServiceLike,
} from "@leitwerk-dev/process-sdk";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerProcessActionRoutes } from "./process-actions.js";
import type { RouteDeps } from "./process-route-helpers.js";

const apps: ReturnType<typeof Fastify>[] = [];

function createHarness(result: ProcessModelSelectionPreviewResultLike) {
	const app = Fastify();
	apps.push(app);
	const preview = vi.fn(async () => result);
	const processModelSelection: ProcessModelSelectionServiceLike = {
		listAvailableProfiles: () => null,
		preview,
	};
	registerProcessActionRoutes(
		app,
		{ processModelSelection } as RouteDeps,
		{} as Parameters<typeof registerProcessActionRoutes>[2],
	);
	return {
		preview,
		inject: (instanceId = "agt_1", input: unknown = {}) =>
			app.inject({
				method: "POST",
				url: `/api/processes/${instanceId}/actions/approve/model-preview`,
				payload: { input },
			}),
	};
}

afterEach(async () => {
	await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("process action model preview route", () => {
	it("returns a valid preview", async () => {
		const projectedPreview: ProcessActionModelPreviewLike = {
			kind: "llm_turn",
			turnId: "implement",
			description: "Implement",
		};
		const harness = createHarness(projectedPreview);

		const response = await harness.inject("agt_1", { note: "normalized" });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ preview: projectedPreview });
		expect(harness.preview).toHaveBeenCalledWith("agt_1", "approve", {
			note: "normalized",
		});
	});

	it.each([
		["process_not_found", 404, "Process not found"],
		["instance_tree_unavailable", 503, "Process model preview is unavailable"],
	] as const)("maps %s to %s", async (code, status, error) => {
		const response = await createHarness({ kind: "operational_failure", code }).inject();

		expect(response.statusCode).toBe(status);
		expect(response.json()).toEqual({ error });
	});

	it("rejects malformed input before calling the module", async () => {
		const harness = createHarness({
			kind: "not_applicable",
			turnId: null,
			description: null,
		});

		const response = await harness.inject("missing", "invalid");

		expect(response.statusCode).toBe(400);
		expect(harness.preview).not.toHaveBeenCalled();
	});
});

import { describe, expect, it } from "vitest";
import {
	presentLauncherModelConfigSchema,
	presentProcessModelPolicyFailure,
} from "../process-model-policy-presenter.js";
import {
	createModelAvailabilitySnapshot,
	createTestModelPolicy,
	createTestProcessInstance,
} from "../test-helpers/process-model-fixtures.js";

describe("server process model policy projection", () => {
	it("returns the precise semantic result for each request kind", () => {
		const { policy } = createTestModelPolicy();

		const profiles = policy.project({
			kind: "profile_options",
			processId: "policy",
			availability: createModelAvailabilitySnapshot(),
		});
		const schema = policy.project({ kind: "launcher_schema", processId: "policy" });

		expect(profiles[0]).toEqual({
			id: "first",
			providerId: "test",
			modelId: "one",
			thinkingLevel: "off",
			availability: "available",
			safeReason: null,
			checkedAt: null,
		});
		expect(schema).toMatchObject({
			profiles: [{ id: "first" }, { id: "second" }],
			turns: [{ turnId: "run" }],
		});
		expect(schema).not.toHaveProperty("kind");
		expect(schema.profiles[0]).not.toHaveProperty("label");
		expect(schema.profiles[0]).not.toHaveProperty("description");
	});

	it("projects process configuration using the definition id rather than the instance id", () => {
		const { policy } = createTestModelPolicy();
		const projection = policy.project({
			kind: "process_configuration",
			process: createTestProcessInstance({
				id: "instance-id",
				processId: "policy",
				selectedTurnModelProfileId: "first",
				selectedTurnModelKind: "inherited",
				selectedTurnModelSource: "catalog_default",
			}),
			availability: createModelAvailabilitySnapshot(),
		});

		expect(projection.turns).toEqual([expect.objectContaining({ turnId: "run" })]);
		expect(projection.effectiveSelectedTurn).toMatchObject({
			turnId: "run",
			modelProfileId: "first",
		});
	});

	it("leaves HTTP shapes and UI copy to the presenter", () => {
		const { policy } = createTestModelPolicy();
		const schema = presentLauncherModelConfigSchema(
			policy.project({ kind: "launcher_schema", processId: "policy" }),
		);
		const failure = policy.evaluate({
			kind: "runtime_selection",
			processId: "policy",
			selection: {
				modelProfileId: "missing",
				provenance: { kind: "explicit", source: "action_override" },
			},
			availability: createModelAvailabilitySnapshot(),
		});

		expect(schema.availableProfiles[0]).toMatchObject({
			id: "first",
			label: "first — test/one",
			description: "Thinking disabled",
			safeReason: "Model status has not been refreshed",
		});
		expect(schema.llmTurns).toEqual([{ turnId: "run", description: "run" }]);
		expect(failure).toMatchObject({
			ok: false,
			code: "unknown_model_profile",
			modelProfileId: "missing",
		});
		if (!failure.ok) {
			expect(presentProcessModelPolicyFailure(failure)).toBe("Unknown model profile 'missing'");
			expect(failure).not.toHaveProperty("summary");
		}
	});
});

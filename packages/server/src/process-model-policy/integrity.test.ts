import { describe, expect, it } from "vitest";
import {
	createTestModelPolicy,
	createTestProcessInstance,
} from "../test-helpers/process-model-fixtures.js";

describe("persisted process model integrity", () => {
	it("reports malformed persisted encoding and relational state", () => {
		const { policy } = createTestModelPolicy();

		expect(
			policy.inspectPersistedState(
				createTestProcessInstance({ turnConfigsJson: JSON.stringify({ run: [] }) }),
			),
		).toMatchObject({
			kind: "malformed",
			issues: [{ code: "invalid_turn_configs_json" }],
		});
		expect(
			policy.inspectPersistedState(
				createTestProcessInstance({
					selectedTurnModelProfileId: "first",
					selectedTurnModelKind: "inherited",
					selectedTurnModelSource: "action_override",
				}),
			),
		).toMatchObject({ kind: "malformed", issues: [{ code: "contradictory_provenance" }] });
	});

	it("accepts a pending explicit launch selection before the first turn is selected", () => {
		const { policy } = createTestModelPolicy();
		const process = createTestProcessInstance({
			selectedTurnId: null,
			lifecycleStatus: "discovered",
			planRevision: 0,
			selectedTurnModelProfileId: "second",
			selectedTurnModelKind: "explicit",
			selectedTurnModelSource: "launch_override",
		});

		expect(policy.inspectPersistedState(process)).toEqual({ kind: "valid" });
	});

	it("does not treat profiles missing from the current catalog or allowlist as corruption", () => {
		const { policy } = createTestModelPolicy({ profiles: [{ id: "available" }] });
		const process = createTestProcessInstance({
			defaultModelProfileId: "removed",
			turnConfigsJson: JSON.stringify({ run: { modelProfileId: "removed" } }),
			selectedTurnModelProfileId: "removed",
			selectedTurnModelKind: "explicit",
			selectedTurnModelSource: "instance_turn_config",
		});

		expect(policy.inspectPersistedState(process)).toEqual({ kind: "valid" });
	});

	it("reports model configuration attached to a non-LLM turn", () => {
		const { policy } = createTestModelPolicy();
		const process = createTestProcessInstance({
			turnConfigsJson: JSON.stringify({ obsolete: { modelProfileId: "first" } }),
		});

		expect(policy.inspectPersistedState(process)).toEqual({
			kind: "malformed",
			issues: [{ code: "model_config_requires_llm_turn", turnId: "obsolete" }],
		});
	});
});

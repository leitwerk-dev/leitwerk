import type { TurnDefinition } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { createDefaultTestProcessGraphRegistry } from "../test-helpers/process-fixtures.js";
import {
	createDoneOutcomeTools,
	createPlanSavedOutcomeTools,
	createTestLlmTurn,
} from "../test-helpers/turn-fixtures.js";
import {
	checkTurnOutcomeAvailability,
	isTurnAvailableForSelectedTurn,
	validateChangedProjects,
	validateTurnOutcome,
} from "./outcome-tools.js";

const registry = createDefaultTestProcessGraphRegistry();

const turnDefinitions = new Map<string, TurnDefinition>([
	["generate_plan", createTestLlmTurn("generate_plan", createPlanSavedOutcomeTools())],
	["implement", createTestLlmTurn("implement", createDoneOutcomeTools())],
]);

function getTurnDefinition(turnId: string): TurnDefinition | undefined {
	return turnDefinitions.get(turnId);
}

describe("turn-outcomes", () => {
	describe("validateChangedProjects", () => {
		it("skips validation when known project keys are unavailable", () => {
			expect(validateChangedProjects(["svc-a", "missing"], undefined)).toBeNull();
		});
	});

	describe("isTurnAvailableForSelectedTurn", () => {
		it("returns true only for the currently selected turn", () => {
			expect(isTurnAvailableForSelectedTurn("generate_plan", "generate_plan")).toBe(true);
			expect(isTurnAvailableForSelectedTurn("generate_plan", "implement")).toBe(false);
			expect(isTurnAvailableForSelectedTurn(null, "generate_plan")).toBe(false);
		});
	});

	describe("checkTurnOutcomeAvailability", () => {
		it("returns null when the turn matches the current selection", () => {
			expect(
				checkTurnOutcomeAvailability(
					registry,
					getTurnDefinition("generate_plan"),
					"generate_plan",
					"plan_saved",
					"ticket_issue_process",
					"generate_plan",
				),
			).toBeNull();
		});

		it("returns turn_not_in_definition when turn is not on process definition", () => {
			const err = checkTurnOutcomeAvailability(
				registry,
				getTurnDefinition("generate_plan"),
				"generate_plan",
				"plan_saved",
				"mr_polish_process",
				"generate_plan",
			);
			expect(err?.code).toBe("turn_not_in_definition");
		});

		it("returns turn_unavailable_for_selected_turn when the selected turn differs", () => {
			const err = checkTurnOutcomeAvailability(
				registry,
				getTurnDefinition("generate_plan"),
				"generate_plan",
				"plan_saved",
				"ticket_issue_process",
				"implement",
			);
			expect(err?.code).toBe("turn_unavailable_for_selected_turn");
		});

		it("returns outcome_not_registered for unknown outcomes", () => {
			const err = checkTurnOutcomeAvailability(
				registry,
				getTurnDefinition("implement"),
				"implement",
				"committed",
				"ticket_issue_process",
				"implement",
			);
			expect(err?.code).toBe("outcome_not_registered");
		});
	});

	describe("validateTurnOutcome", () => {
		it("returns null for a valid generate_plan payload", () => {
			expect(
				validateTurnOutcome(
					{
						instanceId: "agent-1",
						turnRecordId: "trn_plan_1",
						turnId: "generate_plan",
						outcome: "plan_saved",
						params: {
							summary: "Initial plan",
							acceptanceCriteria: ["Do the thing"],
							planMarkdown: "## Plan\n\nSteps.",
						},
					},
					getTurnDefinition("generate_plan"),
				),
			).toBeNull();
		});

		it.each([
			["string", "text", 1, "a string", "strings"],
			["number", 1.5, Infinity, "a finite number", "finite numbers"],
			["boolean", false, 0, "a boolean", "booleans"],
			["object", { key: "value" }, [], "an object", "objects"],
		] as const)("validates %s scalars and array items", (type, valid, invalid, label, plural) => {
			for (const array of [false, true]) {
				const turn = createTestLlmTurn("validate", {
					done: {
						description: "Done",
						parameters: {
							value: { type: array ? "array" : type, items: { type }, description: "Value" },
						},
					},
				});
				const payload = {
					instanceId: "agent",
					turnRecordId: "turn",
					turnId: "validate",
					outcome: "done",
				};
				const validate = (value: unknown) =>
					validateTurnOutcome({ ...payload, params: { value: array ? [value] : value } }, turn);
				expect(validate(valid)).toBeNull();
				expect(validate(invalid)).toEqual({
					ok: false,
					code: "invalid_value",
					message: `validate.done expects value to be ${array ? `an array of ${plural}` : label}`,
				});
			}
		});

		it("validates array items against the declared item schema", () => {
			const metricsTurn = createTestLlmTurn("record_metrics", {
				metrics_recorded: {
					description: "metrics recorded",
					parameters: {
						scores: {
							type: "array",
							description: "Numeric scores",
							items: { type: "number" },
							required: true,
							minItems: 1,
						},
					},
				},
			});

			expect(
				validateTurnOutcome(
					{
						instanceId: "agent-1",
						turnRecordId: "trn_metrics_1",
						turnId: "record_metrics",
						outcome: "metrics_recorded",
						params: { scores: [1, 2.5] },
					},
					metricsTurn,
				),
			).toBeNull();

			const invalid = validateTurnOutcome(
				{
					instanceId: "agent-1",
					turnRecordId: "trn_metrics_2",
					turnId: "record_metrics",
					outcome: "metrics_recorded",
					params: { scores: [1, "two"] },
				},
				metricsTurn,
			);
			expect(invalid?.code).toBe("invalid_scores");
		});

		it("validates required fields and rejects undeclared fields in object-array items", () => {
			const candidateTurn = createTestLlmTurn("find_candidates", {
				candidates_ready: {
					description: "Candidates ready",
					parameters: {
						candidates: {
							type: "array",
							description: "Candidates",
							required: true,
							minItems: 1,
							items: {
								type: "object",
								properties: {
									pattern: { type: "string" },
									evidenceRefs: {
										type: "array",
										minItems: 1,
										items: { type: "string" },
									},
								},
								required: ["pattern", "evidenceRefs"],
								additionalProperties: false,
							},
						},
					},
				},
			});
			const validate = (candidates: unknown) =>
				validateTurnOutcome(
					{
						instanceId: "agent",
						turnRecordId: "turn",
						turnId: "find_candidates",
						outcome: "candidates_ready",
						params: { candidates },
					},
					candidateTurn,
				);
			expect(validate([{ pattern: "failure", evidenceRefs: ["ev-1"] }])).toBeNull();
			expect(validate([{ pattern: "failure" }])?.code).toBe("invalid_candidates");
			expect(
				validate([{ pattern: "failure", evidenceRefs: ["ev-1"], unexpected: true }])?.code,
			).toBe("invalid_candidates");
			expect(validate([{ pattern: "failure", evidenceRefs: [] }])?.code).toBe("invalid_candidates");
		});

		it.each([
			[{}, "summary_required"],
			[{ summary: "" }, "summary_required"],
			[{ summary: "Done" }, undefined],
			[{ summary: "Done", changedProjects: undefined }, undefined],
			[{ summary: "Done", changedProjects: null }, "invalid_changed_projects"],
			[{ summary: "Done", extra: true }, "unknown_parameter"],
		] as const)("validates parameter presence and unknown keys: %j", (params, code) => {
			expect(
				validateTurnOutcome(
					{
						instanceId: "agent",
						turnRecordId: "turn",
						turnId: "implement",
						outcome: "done",
						params,
					},
					createTestLlmTurn("implement", createDoneOutcomeTools({ includeChangedProjects: true })),
				)?.code,
			).toBe(code);
		});

		it("returns error when instanceId is missing", () => {
			const res = validateTurnOutcome(
				{
					instanceId: "",
					turnRecordId: "trn_plan_1",
					turnId: "generate_plan",
					outcome: "plan_saved",
					params: {
						summary: "Initial plan",
						acceptanceCriteria: ["Do the thing"],
						planMarkdown: "## Plan",
					},
				},
				getTurnDefinition("generate_plan"),
			);
			expect(res?.code).toBe("missing_instance_id");
		});
	});
});

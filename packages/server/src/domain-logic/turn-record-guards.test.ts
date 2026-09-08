import { createTestProcessInstance } from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import {
	validateTurnFailedCorrelation,
	validateTurnOutcomeCorrelation,
} from "./turn-record-guards.js";

const process = createTestProcessInstance();

describe("turn-record-guards", () => {
	it("rejects turn outcomes without turnRecordId", () => {
		const result = validateTurnOutcomeCorrelation(
			process,
			{
				instanceId: process.id,
				turnRecordId: "",
				turnId: "generate_plan",
				turnType: "llm",
				outcome: "plan_saved",
				params: {},
			},
			"trn_current",
		);
		expect(result?.code).toBe("missing_turn_record_id");
	});

	it("rejects stale turn outcomes", () => {
		const result = validateTurnOutcomeCorrelation(
			process,
			{
				instanceId: process.id,
				turnRecordId: "trn_stale",
				turnId: "generate_plan",
				turnType: "llm",
				outcome: "plan_saved",
				params: {},
				pathType: "primary",
			},
			"trn_current",
		);
		expect(result?.code).toBe("stale_turn_record");
	});

	it("accepts a correlated turn outcome", () => {
		expect(
			validateTurnOutcomeCorrelation(
				process,
				{
					instanceId: process.id,
					turnRecordId: "trn_current",
					turnId: "generate_plan",
					turnType: "llm",
					outcome: "plan_saved",
					params: {},
					pathType: "primary",
				},
				"trn_current",
			),
		).toBeNull();
	});

	it("rejects stale turn failures", () => {
		const result = validateTurnFailedCorrelation(
			process,
			{
				instanceId: process.id,
				turnRecordId: "trn_stale",
				turnId: "implement",
				turnType: "llm",
				pathType: "primary",
				errorSummary: "boom",
				errorClass: "llm_error",
			},
			"trn_current",
		);
		expect(result?.code).toBe("stale_turn_record");
	});
});

import { createTestProcessInstance } from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import {
	validateTurnFailedCorrelation,
	validateTurnOutcomeCorrelation,
} from "./turn-record-guards.js";

describe("turn-record-guards", () => {
	it("rejects turn outcomes without turnRecordId", () => {
		const process = createTestProcessInstance({
			currentExecution: { kind: "server_turn", id: "trn_current" },
		});
		const result = validateTurnOutcomeCorrelation(process, {
			instanceId: process.id,
			turnRecordId: "",
			turnId: "generate_plan",
			outcome: "plan_saved",
			params: {},
		});
		expect(result?.ok).toBe(false);
		expect(result?.code).toBe("missing_turn_record_id");
	});

	it("rejects stale turn outcomes when turnRecordId does not match current execution", () => {
		const process = createTestProcessInstance({
			currentExecution: { kind: "server_turn", id: "trn_current" },
		});
		const result = validateTurnOutcomeCorrelation(process, {
			instanceId: process.id,
			turnRecordId: "trn_stale",
			turnId: "generate_plan",
			outcome: "plan_saved",
			params: {},
			pathType: "primary",
		});
		expect(result?.ok).toBe(false);
		expect(result?.code).toBe("stale_turn_record");
	});

	it("accepts a turn outcome when turnRecordId matches current execution", () => {
		const process = createTestProcessInstance({
			currentExecution: { kind: "server_turn", id: "trn_current" },
		});
		const result = validateTurnOutcomeCorrelation(process, {
			instanceId: process.id,
			turnRecordId: "trn_current",
			turnId: "generate_plan",
			outcome: "plan_saved",
			params: {},
			pathType: "primary",
		});
		expect(result).toBeNull();
	});

	it("rejects stale turn failures when turnRecordId does not match current execution", () => {
		const process = createTestProcessInstance({
			currentExecution: { kind: "server_turn", id: "trn_current" },
		});
		const result = validateTurnFailedCorrelation(process, {
			instanceId: process.id,
			turnRecordId: "trn_stale",
			turnId: "implement",
			pathType: "primary",
			errorSummary: "boom",
			errorClass: "llm_error",
		});
		expect(result?.ok).toBe(false);
		expect(result?.code).toBe("stale_turn_record");
	});
});

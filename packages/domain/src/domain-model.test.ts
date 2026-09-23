import { describe, expect, it } from "vitest";
import {
	isProcessTurnType,
	isTurnFailureCode,
	isWaitingTurnType,
	isWorkerErrorClass,
	isWorkerOwnedTurnType,
	lifecycleStatusForSelectedTurnType,
	PROCESS_TURN_TYPES,
} from "./index.js";

describe("domain-model", () => {
	it("recognizes known worker error classes", () => {
		for (const errorClass of [
			"llm_error",
			"git_error",
			"pi_crash",
			"pipeline_error",
			"infrastructure",
			"protocol_error",
			"operator_abort",
		]) {
			expect(isWorkerErrorClass(errorClass), errorClass).toBe(true);
		}
		expect(isWorkerErrorClass("not_an_error_class")).toBe(false);
	});

	it("recognizes durable turn failure codes", () => {
		expect(isTurnFailureCode("branch_drift")).toBe(true);
		expect(isTurnFailureCode("not_a_failure_code")).toBe(false);
	});

	it("describes durable turn type scheduling semantics", () => {
		expect(PROCESS_TURN_TYPES.every(isProcessTurnType)).toBe(true);
		expect(isProcessTurnType("unknown")).toBe(false);
		expect(isProcessTurnType("toString")).toBe(false);
		expect(isProcessTurnType(null)).toBe(false);
		expect(
			PROCESS_TURN_TYPES.map((turnType) => [
				turnType,
				isWorkerOwnedTurnType(turnType),
				isWaitingTurnType(turnType),
				lifecycleStatusForSelectedTurnType(turnType),
			]),
		).toEqual([
			["llm", true, false, "active"],
			["human", false, true, "waiting"],
			["external", false, true, "waiting"],
			["automatic", true, false, "active"],
		]);
	});
});

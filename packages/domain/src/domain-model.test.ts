import { describe, expect, it } from "vitest";
import {
	createEmptyProcessSemanticEntryRefs,
	detectRepoLocatorKind,
	isProcessTurnType,
	isTurnFailureCode,
	isWaitingTurnType,
	isWorkerErrorClass,
	isWorkerOwnedTurnType,
	lifecycleStatusForSelectedTurnType,
	PROCESS_TURN_TYPES,
	parseProcessSemanticEntryRefs,
	parseSemanticEntryRef,
	WORKER_ERROR_CLASSES,
} from "./index.js";

describe("domain-model", () => {
	it("recognizes known worker error classes", () => {
		for (const errorClass of WORKER_ERROR_CLASSES) {
			expect(isWorkerErrorClass(errorClass)).toBe(true);
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

	it("detects remote and local repo locators", () => {
		expect(detectRepoLocatorKind("https://example.com/repo.git")).toBe("remote_url");
		expect(detectRepoLocatorKind("git@example.com:team/repo.git")).toBe("remote_url");
		expect(detectRepoLocatorKind("/tmp/repo")).toBe("local_path");
		expect(detectRepoLocatorKind("../repo")).toBe("local_path");
		expect(detectRepoLocatorKind("not a locator")).toBeNull();
	});

	it("parses semantic entry refs and defaults missing refs to null", () => {
		expect(parseSemanticEntryRef({ entryId: "ent_1", turnRecordId: "trn_1" })).toEqual({
			entryId: "ent_1",
			turnRecordId: "trn_1",
		});
		expect(parseSemanticEntryRef({ entryId: "" })).toBeNull();
		expect(
			parseProcessSemanticEntryRefs({
				plan: { entryId: "ent_plan", turnRecordId: "trn_plan" },
				rootEntry: { entryId: "ent_root" },
			}),
		).toEqual({
			...createEmptyProcessSemanticEntryRefs(),
			plan: { entryId: "ent_plan", turnRecordId: "trn_plan" },
			rootEntry: { entryId: "ent_root", turnRecordId: null },
		});
	});
});

import type { ProcessEvent, TurnStartRecord } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { automaticStartupRecovery, startupRetryState } from "./startup-retry-policy.js";
import { createTestTurnStart } from "./test-helpers/process-model-fixtures.js";

function start(
	id: string,
	kind: "selected_turn" | "startup_retry" = "selected_turn",
): TurnStartRecord {
	return createTestTurnStart({
		id,
		turnType: "automatic",
		startKind: kind,
		createdAt: "2026-10-14T12:00:00Z",
		updatedAt: "2026-10-14T12:00:00Z",
		state: {
			kind: "bootstrap_failed",
			start: { kind: "automatic" },
			failedWorkerLeaseId: null,
			code: "startup_timeout",
			safeSummary: "Timeout",
		},
	});
}

describe("startup retry policy", () => {
	it("recovers a legacy budget through retry history instead of resetting on upgrade", () => {
		const latest = start("s3", "startup_retry");
		const starts = [start("s1"), start("s2", "startup_retry"), latest];
		const events = [2, 3].map((n) => ({
			id: `e${n}`,
			instanceId: "p",
			eventType: "startup_retry_scheduled",
			data: {
				startRecordId: `s${n}`,
				previousStartRecordId: `s${n - 1}`,
				actor: { kind: "system" },
			},
			createdAt: "",
		})) as ProcessEvent[];
		const retry = startupRetryState(latest, starts, events);
		expect(retry).toMatchObject({ episodeStartRecordId: "s1", starts: 3 });
		expect(automaticStartupRecovery(latest, retry)).toMatchObject({ status: "exhausted" });
		expect(startupRetryState(latest, [], [])).toMatchObject({ starts: 3 });
	});
	it("does not reset exhausted budgets when model availability returns", () => {
		const failed = start("s3", "startup_retry");
		failed.state = {
			kind: "preparation_failed",
			requestedModelProfileId: "model",
			providerOptions: {},
			code: "model_unavailable",
			safeSummary: "Unavailable",
		};
		const retry = { episodeStartRecordId: "s1", starts: 3, nextRetryAt: null };
		expect(automaticStartupRecovery(failed, retry, Date.now(), true)).toMatchObject({
			status: "exhausted",
		});
		expect(automaticStartupRecovery(failed, { ...retry, starts: 1 })).toMatchObject({
			status: "waiting_for_model",
			nextRetryAt: null,
		});
	});
	it.each([
		"process_oom_killed",
		"credential_missing",
		"unsupported_runtime",
		"unknown",
	])("requires attention for %s", (code) => {
		const failed = start("s1");
		if (failed.state.kind !== "bootstrap_failed") throw new Error("Expected bootstrap fixture");
		failed.state.code = code;
		expect(automaticStartupRecovery(failed, startupRetryState(failed, []))).toMatchObject({
			status: "blocked",
			nextRetryAt: null,
		});
	});
});

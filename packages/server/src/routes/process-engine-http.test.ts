import type { ProcessInstance } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import type { EngineFailure } from "../process-engine/types.js";
import { mapEngineFailure } from "./process-engine-http.js";

function makeProcess(id: string, processId = "ticket_issue_process"): ProcessInstance {
	return {
		id,
		processId,
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
		currentExecution: null,
		planRevision: 0,
		title: null,
		externalId: null,
		externalUrl: null,
		metadata: null,
		paramsJson: null,
		stateJson: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

function makeFailure<T>(overrides: Partial<EngineFailure<T>> = {}): EngineFailure<T> {
	return {
		ok: false,
		code: "invalid_transition",
		message: "Operation failed",
		...overrides,
	} as EngineFailure<T>;
}

describe("mapEngineFailure", () => {
	it("maps process_not_found to 404", () => {
		expect(
			mapEngineFailure(
				makeFailure({
					code: "process_not_found",
					message: "Process not found",
				}),
				"steer",
			),
		).toEqual({
			status: 404,
			body: { error: "Process not found" },
		});
	});

	it("preserves the steer route's code-only 400 behavior", () => {
		const result = mapEngineFailure(
			makeFailure({
				code: "invalid_transition",
				message: "Steering failed",
			}),
			"steer",
		);

		expect(result).toEqual({
			status: 400,
			body: { error: "Steering failed", code: "invalid_transition" },
		});
	});

	it("maps internal engine failures to sanitized 500 responses", () => {
		const result = mapEngineFailure(
			makeFailure({
				code: "record_failed",
				message:
					"SQLITE_BUSY: database unavailable at /private/tmp/leitwerk.sqlite\n    at Database.prepare (/repo/internal.js:10:5)",
				stage: "pre_commit",
			}),
			"retry",
		);

		expect(result.status).toBe(500);
		expect(result.body).toMatchObject({
			code: "record_failed",
			error: "Process operation failed during durable recording",
		});
		const serialized = JSON.stringify(result.body);
		expect(serialized).not.toContain("SQLITE_BUSY");
		expect(serialized).not.toContain("/private/tmp/leitwerk.sqlite");
		expect(serialized).not.toContain("Database.prepare");
	});

	it("uses the route-specific abort worker reconcile message", () => {
		expect(
			mapEngineFailure(
				makeFailure({
					code: "worker_reconcile_failed",
					message: "ignored",
					process: makeProcess("agt_abort"),
				}),
				"abort",
			),
		).toEqual({
			status: 503,
			body: {
				error: "Process was aborted, but the worker could not be stopped cleanly",
				process: expect.objectContaining({ id: "agt_abort" }),
			},
		});
	});

	it("uses the direct engine code for default abort 400 responses", () => {
		const result = mapEngineFailure(
			makeFailure({
				code: "invalid_transition",
				message: "Transition rejected",
			}),
			"abort",
		);

		expect(result).toEqual({
			status: 400,
			body: { error: "Transition rejected", code: "invalid_transition" },
		});
	});

	it("uses the route-specific retry worker reconcile message", () => {
		expect(
			mapEngineFailure(
				makeFailure({
					code: "worker_reconcile_failed",
					message: "ignored",
					process: makeProcess("agt_retry"),
				}),
				"retry",
			),
		).toEqual({
			status: 503,
			body: {
				error: "Process was reactivated, but the worker could not be started cleanly",
				process: expect.objectContaining({ id: "agt_retry" }),
			},
		});
	});

	it("uses the same worker reconcile message for continue", () => {
		expect(
			mapEngineFailure(
				makeFailure({
					code: "worker_reconcile_failed",
					message: "ignored",
					process: makeProcess("agt_continue"),
				}),
				"continue",
			),
		).toEqual({
			status: 503,
			body: {
				error: "Process was reactivated, but the worker could not be started cleanly",
				process: expect.objectContaining({ id: "agt_continue" }),
			},
		});
	});
});

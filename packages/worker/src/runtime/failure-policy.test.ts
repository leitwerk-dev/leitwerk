import { describe, expect, it } from "vitest";
import { TurnExecutionError } from "../turn-execution-error.js";
import {
	extractSecretValuesFromPayload,
	normalizeWorkerFailure,
	redactSecrets,
} from "./failure-policy.js";
import { createWorkerRuntime } from "./index.js";

describe("worker runtime", () => {
	it("exports the worker runtime factory", () => {
		expect(typeof createWorkerRuntime).toBe("function");
	});

	it("extracts secret values from LLM start payload credential", () => {
		const payload = {
			bootstrap: {
				kind: "llm",
				credential: {
					providerId: "test",
					revision: 1,
					values: {
						token: "secret-token-123",
						apiKey: "sk-proj-abc456",
						empty: "",
					},
				},
			},
		} as unknown as Parameters<typeof extractSecretValuesFromPayload>[0];
		const secrets = extractSecretValuesFromPayload(payload);
		expect(secrets).toEqual(["secret-token-123", "sk-proj-abc456"]);
	});

	it("redacts delivered secret values from diagnostic messages and error summaries", () => {
		const secrets = ["secret-token-123", "sk-proj-abc456"];
		const message = "Failed to authenticate with token secret-token-123 and apiKey sk-proj-abc456";
		const redacted = redactSecrets(message, secrets);
		expect(redacted).toBe("Failed to authenticate with token <redacted> and apiKey <redacted>");
		expect(redacted).not.toContain("secret-token-123");
		expect(redacted).not.toContain("sk-proj-abc456");
	});

	it("normalizes accepted turn failures to one correlated failure and park disposition", () => {
		const disposition = normalizeWorkerFailure({
			kind: "turn",
			error: new TurnExecutionError("review", "model", "model unavailable"),
			correlation: { turnRecordId: "trn_3", turnId: "review" },
		});
		expect(disposition.terminal).toMatchObject({
			kind: "turn_failed",
			payload: {
				turnRecordId: "trn_3",
				turnId: "review",
				errorClass: "model",
				errorSummary: "model unavailable",
			},
			park: { selectedTurnId: "review", errorClass: "model" },
		});
	});

	it("normalizes bootstrap errors with redaction, bounded summaries, and no turn failure", () => {
		const payload = {
			bootstrap: { kind: "llm", credential: { values: { token: "secret-token" } } },
			processSnapshot: { selectedTurnId: "implement", lifecycleStatus: "running" },
			treePaths: { primaryTreeFile: "/tmp/primary.jsonl" },
		} as unknown as Parameters<typeof extractSecretValuesFromPayload>[0];
		const disposition = normalizeWorkerFailure({
			kind: "bootstrap",
			error: new Error(`secret-token ${"x".repeat(250)}`),
			payload,
		});
		expect(disposition.terminal.kind).toBe("worker_failed");
		expect(disposition.snapshot?.point).toBe("before_worker_failed");
		expect(
			JSON.stringify({
				diagnostic: disposition.diagnostic,
				stderrMessage: disposition.stderrMessage,
				terminal: disposition.terminal,
			}),
		).not.toContain("secret-token");
		if (disposition.terminal.kind === "worker_failed") {
			expect(disposition.terminal.payload.message.length).toBeLessThanOrEqual(200);
		}
	});

	it("parks dispatch failures while the process remains recoverable", () => {
		const disposition = normalizeWorkerFailure({
			kind: "dispatch",
			error: new Error("delivery failed"),
			state: "busy",
			session: {
				payload: { bootstrap: { kind: "automatic" } } as Parameters<
					typeof extractSecretValuesFromPayload
				>[0],
				selectedTurnId: "review",
				lifecycleStatus: "running",
			},
		});
		expect(disposition.terminal).toEqual({
			kind: "park",
			payload: {
				selectedTurnId: "review",
				reason: "delivery failed",
				errorClass: "infrastructure",
			},
		});
		expect(disposition.exitCode).toBeUndefined();
	});

	it("makes cleanup unrecoverable and transport failures non-reportable", () => {
		const cleanup = normalizeWorkerFailure({
			kind: "cleanup",
			error: new Error("release failed"),
			session: null,
		});
		expect(cleanup.terminal).toMatchObject({
			kind: "worker_failed",
			payload: { state: "cleanup", errorCode: "cleanup_failed" },
		});
		expect(cleanup.exitCode).toBe(1);

		const transport = normalizeWorkerFailure({
			kind: "transport",
			error: new Error("pipe closed"),
		});
		expect(transport).toMatchObject({
			diagnostic: null,
			terminal: { kind: "transport_lost" },
			exitCode: 1,
		});
	});
});

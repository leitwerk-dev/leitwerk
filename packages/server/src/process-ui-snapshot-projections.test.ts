import type { ProcessEvent, ProcessTurnRecord } from "@leitwerk-dev/domain";
import type {
	ProcessExternalTriggerSummary,
	TurnTracePreview,
	TurnUsageSnapshot,
} from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";
import {
	buildExternalTriggerSignals,
	buildUsageEstimate,
	formatProcessErrorPresentation,
} from "./process-ui-snapshot-presenter.js";

function event(
	eventType: string,
	createdAt: string,
	data: Record<string, unknown> = {},
): ProcessEvent {
	return { id: `${eventType}:${createdAt}`, instanceId: "agt_1", eventType, data, createdAt };
}

function trigger(
	overrides: Partial<ProcessExternalTriggerSummary> = {},
): ProcessExternalTriggerSummary {
	return {
		id: "review:file",
		kind: "test.file.instruction",
		sourceKind: "test.file.instruction",
		externalActionId: "file",
		label: "Review file",
		description: "Write feedback to the trigger file.",
		...overrides,
	};
}

function turn(id: string, overrides: Partial<ProcessTurnRecord> = {}): ProcessTurnRecord {
	const turnType = overrides.turnType ?? "llm";
	const workerOwned = turnType === "llm" || turnType === "automatic";
	return {
		id,
		instanceId: "agt_1",
		turnId: "generate_plan",
		turnType,
		status: "succeeded",
		attemptNumber: 1,
		parentTurnRecordId: null,
		pathType: "primary",
		forkPiEntryId: null,
		turnStartRecordId: workerOwned ? `tsr_${id}` : null,
		acceptedWorkerLeaseId: workerOwned ? `wls_${id}` : null,
		resultPiEntryId: null,
		modelProfileId: null,
		turnResultMarkdown: null,
		errorSummary: null,
		errorClass: null,
		startedAt: "2026-01-01T00:00:00Z",
		endedAt: "2026-01-01T00:01:00Z",
		...overrides,
	};
}

function usage(input: number, output: number, cost: number | null = 0.75): TurnUsageSnapshot {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost:
			cost === null
				? null
				: { input: cost * (2 / 3), output: cost / 3, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function preview(turnRecordId: string, turnUsage: TurnUsageSnapshot): TurnTracePreview {
	return {
		turnRecordId,
		assistantTextPreview: "",
		assistantTextTruncated: false,
		thinkingPreview: "",
		thinkingPreviewTruncated: false,
		toolCallCount: 0,
		traceItemCount: 0,
		hasReasoningDetails: true,
		usage: turnUsage,
		piInput: null,
	};
}

describe("process error presentation", () => {
	it("unwraps provider envelopes and strips internal turn prefixes", () => {
		const raw =
			'Turn \'review_implementation\' prompt failed: 402 {"error":{"message":"Monthly request limit exceeded."}}';
		expect(formatProcessErrorPresentation(raw, "llm_error")).toEqual({
			summary: "The model request failed — monthly request limit exceeded.",
			guidance:
				"Retry once provider capacity or quota is available, or switch to a different model before continuing.",
			technicalDetail: raw,
		});
	});

	it.each([
		["Something broke", null, "Something broke", null],
		[
			"remote rejected push",
			"git_error",
			"A git operation failed — remote rejected push",
			"remote rejected push",
		],
		["", "pi_crash", "The agent crashed", null],
		[
			"API key invalid",
			"llm_error",
			"The model request failed — API key invalid",
			"API key invalid",
		],
	] as const)("formats %s", (reason, errorClass, summary, technicalDetail) => {
		const result = formatProcessErrorPresentation(reason, errorClass);
		expect(result.summary).toBe(summary);
		expect(result.technicalDetail).toBe(technicalDetail);
	});
});

describe("external trigger signals", () => {
	it("shows armed setup details", () => {
		expect(
			buildExternalTriggerSignals({
				externalTriggers: [trigger()],
				events: [
					event("external_source_armed", "2026-01-01T00:09:30Z", {
						armingId: "review:file",
						path: "/tmp/review",
						pollInterval: "50ms",
					}),
				],
				isWaitingForSelectedTurn: true,
			}),
		).toEqual([
			{
				triggerId: "review:file",
				state: "armed",
				occurredAt: "2026-01-01T00:09:30Z",
				secondaryDetail: "Watching /tmp/review · polling every 50ms.",
			},
		]);
	});

	it("correlates and reports only the matching trigger failure", () => {
		const signals = buildExternalTriggerSignals({
			externalTriggers: [trigger({ id: "review:first" }), trigger({ id: "review:second" })],
			events: [
				event("external_source_failed", "2026-01-01T00:09:45Z", {
					armingId: "review:second",
					message: "action_not_visible",
				}),
			],
			isWaitingForSelectedTurn: false,
		});
		expect(signals[0]).toMatchObject({ triggerId: "review:first", state: "waiting" });
		expect(signals[1]).toMatchObject({
			triggerId: "review:second",
			state: "error",
			occurredAt: "2026-01-01T00:09:45Z",
		});
	});
});

describe("process usage estimates", () => {
	it("prefers live usage for the active turn and committed previews for completed turns", () => {
		const completedUsage = usage(100, 20);
		const liveUsage = usage(80, 30, 0.375);
		const estimate = buildUsageEstimate({
			turnRecords: [turn("done"), turn("live", { status: "running", endedAt: null })],
			activeTurn: {
				turnRecordId: "live",
				turnId: "generate_plan",
				turnType: "llm",
				pathType: "primary",
				startedAt: "2026-01-01T00:02:00Z",
				assistant: { text: "", thinking: "", lastUpdatedAt: null },
				toolCalls: [],
				traceItems: [],
				usage: liveUsage,
				eventWindowTruncated: false,
			},
			currentTurnRecordId: "live",
			usageByTurnRecordId: { done: usage(1, 1), live: usage(999, 999) },
			tracePreviewsByTurnRecordId: { done: preview("done", completedUsage) },
		});
		expect(estimate).toMatchObject({
			includesLiveTurn: true,
			totalLlmTurnCount: 2,
			coveredTurnCount: 2,
			isPartial: false,
			usage: { input: 180, output: 50, totalTokens: 230 },
		});
	});

	it("tracks missing usage and missing cost separately", () => {
		const estimate = buildUsageEstimate({
			turnRecords: [turn("with-cost"), turn("without-cost"), turn("missing")],
			activeTurn: null,
			currentTurnRecordId: null,
			usageByTurnRecordId: {
				"with-cost": usage(100, 20),
				"without-cost": usage(60, 10, null),
			},
			tracePreviewsByTurnRecordId: {},
		});
		expect(estimate).toMatchObject({
			totalLlmTurnCount: 3,
			coveredTurnCount: 2,
			missingUsageTurnCount: 1,
			missingCostTurnCount: 1,
			isPartial: true,
		});
	});
});

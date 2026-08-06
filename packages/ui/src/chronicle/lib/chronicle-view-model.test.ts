import {
	type ProcessTimelineTurnSummary,
	timelinePresentationForTurnType,
} from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";

type TurnRecordView = ProcessTimelineTurnSummary;

import {
	buildChronicleTurnRailItem,
	formatChronicleTurnLabel,
	getChronicleTurnPresentation,
	getChronicleTurnPreview,
	getChronicleTurnShape,
} from "./chronicle-view-model.js";

function makeTurnRecord(overrides: Partial<TurnRecordView> = {}): TurnRecordView {
	const turnId = overrides.turnId ?? "run_single_prompt";
	return {
		id: overrides.id ?? "trn_1",
		turnId,
		turnType: overrides.turnType ?? "llm",
		displayTurn: overrides.displayTurn ?? turnId,
		outcome: overrides.outcome ?? "completed",
		summary: overrides.summary ?? "Summary",
		output: overrides.output ?? "Output",
		turnResultMarkdown: overrides.turnResultMarkdown ?? "",
		pathType: overrides.pathType ?? "primary",
		createdAt: overrides.createdAt ?? "2026-04-18T10:00:00.000Z",
		presentation:
			overrides.presentation ?? timelinePresentationForTurnType(overrides.turnType ?? "llm"),
		status: overrides.status ?? "completed",
		modelProfileId: overrides.modelProfileId ?? null,
		attemptNumber: overrides.attemptNumber ?? 1,
		parentTurnRecordId: overrides.parentTurnRecordId ?? null,
		startedAt: overrides.startedAt ?? "2026-04-18T10:00:00.000Z",
		endedAt: overrides.endedAt ?? "2026-04-18T10:01:00.000Z",
	};
}

describe("chronicle view model", () => {
	it("formats concrete turn labels for display", () => {
		expect(formatChronicleTurnLabel("run_single_prompt")).toBe("Run Single Prompt");
	});

	it("maps turn records to distinct Turn Rail shapes", () => {
		expect(getChronicleTurnShape(makeTurnRecord({ turnId: "run_single_prompt" }))).toBe("circle");
		expect(getChronicleTurnShape(makeTurnRecord({ turnId: "run_llm_review" }))).toBe("diamond");
		expect(getChronicleTurnShape(makeTurnRecord({ turnId: "plan_review" }))).toBe("pill");
		expect(getChronicleTurnShape(makeTurnRecord({ outcome: "failed" }))).toBe("square");
		expect(
			getChronicleTurnShape(
				makeTurnRecord({ turnType: "human", turnId: "implementation_review", outcome: "failed" }),
			),
		).toBe("square");
		expect(
			getChronicleTurnShape(
				makeTurnRecord({ turnType: "external", turnId: "poem_review", outcome: "failed" }),
			),
		).toBe("square");
	});

	it("classifies automatic turns as orchestration automation", () => {
		expect(getChronicleTurnPresentation(makeTurnRecord({ turnType: "automatic" }))).toBe(
			"automatic_turn",
		);
		const railItem = buildChronicleTurnRailItem(
			makeTurnRecord({ id: "trn_auto", turnId: "commit_and_merge", turnType: "automatic" }),
		);
		expect(railItem).toEqual(
			expect.objectContaining({
				kindLabel: "Automation",
				hierarchy: "primary",
				shape: "circle",
			}),
		);
	});

	it("classifies external-trigger annotations as external trigger turns", () => {
		expect(
			getChronicleTurnPresentation(
				makeTurnRecord({
					turnType: "external",
					presentation: "external_trigger",
				}),
			),
		).toBe("external_trigger");
	});

	it("builds markdown-aware previews", () => {
		expect(
			getChronicleTurnPreview(
				makeTurnRecord({
					turnResultMarkdown: "## Result\n\n- Ship it",
					output: "",
					summary: "",
				}),
			),
		).toBe("Result Ship it");
	});
});

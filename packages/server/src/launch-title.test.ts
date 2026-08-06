import type { ProcessLaunchPlan } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import {
	applySubmittedProcessTitleToLaunchPlan,
	MAX_PROCESS_TITLE_LENGTH,
	normalizeProcessTitleInput,
	normalizeSubmittedProcessTitle,
} from "./launch-title.js";

function createLaunchPlan(title: string | null = null): ProcessLaunchPlan {
	return {
		launcherId: "test.launcher",
		processId: "test_process",
		processInput: {
			processId: "test_process",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
			title,
			externalId: null,
			externalUrl: null,
			metadata: null,
			paramsJson: "{}",
			stateJson: "{}",
		},
		projectInputs: [],
		startTurnId: null,
	};
}

describe("normalizeProcessTitleInput", () => {
	it("returns null for non-string and blank values", () => {
		expect(normalizeProcessTitleInput(undefined)).toBeNull();
		expect(normalizeProcessTitleInput(null)).toBeNull();
		expect(normalizeProcessTitleInput("   ")).toBeNull();
	});

	it("trims and flattens whitespace for explicit titles", () => {
		expect(normalizeSubmittedProcessTitle("Implement sidebar")).toBe("Implement sidebar");
		expect(normalizeSubmittedProcessTitle("  Implement\n sidebar  ")).toBe("Implement sidebar");
	});

	it("caps overly long titles at the shared process-title limit", () => {
		const title = normalizeProcessTitleInput(
			"Implement a very long process title that keeps rambling past what should be persisted in compact operator-facing process lists",
		);
		expect(title).not.toBeNull();
		expect(title?.length).toBeLessThanOrEqual(MAX_PROCESS_TITLE_LENGTH);
		expect(title?.endsWith("…")).toBe(true);
	});
});

describe("applySubmittedProcessTitleToLaunchPlan", () => {
	it("keeps the existing launch plan title when no submitted title was provided", () => {
		const launchPlan = createLaunchPlan("Existing title");
		expect(
			applySubmittedProcessTitleToLaunchPlan(launchPlan, {
				title: "New title",
				titleProvided: false,
			}),
		).toBe(launchPlan);
	});

	it("replaces the launch plan title when a submitted title is provided", () => {
		const launchPlan = createLaunchPlan("Existing title");
		expect(
			applySubmittedProcessTitleToLaunchPlan(launchPlan, {
				title: "Submitted title",
				titleProvided: true,
			}),
		).toMatchObject({
			processInput: {
				title: "Submitted title",
			},
		});
	});

	it("clears the launch plan title when a blank submitted title normalized to null is provided", () => {
		const launchPlan = createLaunchPlan("Existing title");
		expect(
			applySubmittedProcessTitleToLaunchPlan(launchPlan, {
				title: null,
				titleProvided: true,
			}),
		).toMatchObject({
			processInput: {
				title: null,
			},
		});
	});
});

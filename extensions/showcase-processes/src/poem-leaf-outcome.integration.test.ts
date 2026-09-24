import {
	type ExtensionIntegrationHarness,
	type ExtensionIntegrationHarnessOptions,
	waitForValue,
} from "@leitwerk-dev/test-support/integration";
import { describe, expect, it } from "vitest";
import { createShowcaseHarness, http } from "./testing/harness.js";

type ReviewScript =
	| {
			outcome: "leave_feedback";
			summary: string;
			feedback: string;
	  }
	| {
			outcome: "no_issues";
			summary: string;
	  };

interface ReviewPromptCapture {
	promptText: string;
}
function createPoemSnapshotScript(
	markdowns: readonly string[],
	reviewScript?: ReviewScript,
	options: { reviewPrompts?: ReviewPromptCapture[] } = {},
): NonNullable<ExtensionIntegrationHarnessOptions["script"]> {
	let draftIndex = 0;
	return (_id, promptText, observation) => {
		if (reviewScript && observation.turnId === "review_poem_draft") {
			options.reviewPrompts?.push({ promptText });
			return {
				tools: [
					{
						name: reviewScript.outcome,
						arguments:
							reviewScript.outcome === "leave_feedback"
								? {
										summary: reviewScript.summary,
										message: `## Review feedback\n\n${reviewScript.feedback}`,
									}
								: { summary: reviewScript.summary, review: `## Review\n\n${reviewScript.summary}` },
					},
				],
			};
		}
		const markdown =
			markdowns[Math.min(draftIndex++, markdowns.length - 1)] ?? "# Untitled\n\nNo poem";
		return { tools: [{ name: "markdown_result", arguments: { markdown } }] };
	};
}

async function launchPoemProcess(harness: ExtensionIntegrationHarness) {
	const prompt = "Write a short poem about Berlin rooftops and release trains at dusk.";
	const process = await harness.launch("poem_creator_process.poem_creator_ui", { prompt });
	return { instanceId: process.snapshot().process.id, prompt };
}
async function runPoemAutoReview(harness: ExtensionIntegrationHarness, instanceId: string) {
	await harness.process(instanceId).action("run_poem_auto_review");
}

describe("poem leaf outcome adoption", () => {
	it.each([
		{
			script: {
				outcome: "leave_feedback",
				summary: "The poem needs revision before publication.",
				feedback: "Sharpen the closing image and brighten the rhythm.",
			},
			suffix:
				"## Review\n\nThe poem needs revision before publication.\n\n## Review feedback\n\nSharpen the closing image and brighten the rhythm.",
			feedback: "## Review feedback\n\nSharpen the closing image and brighten the rhythm.",
		},
		{
			script: { outcome: "no_issues", summary: "The revised poem is ready to publish." },
			suffix: "## LLM Opinion\n\nThe revised poem is ready to publish.",
			feedback: null,
		},
	] as const)("captures a review-leaf snapshot with $script.outcome", async ({
		script,
		suffix,
		feedback,
	}) => {
		const reviewPrompts: ReviewPromptCapture[] = [];
		const poemMarkdown =
			"# Berlin Release\n\nTin rooftops glimmer<br>Release wires sing\n\nDeploy lights gather<br>At the edge of spring";
		const harness = await createShowcaseHarness({
			script: createPoemSnapshotScript([poemMarkdown], script, { reviewPrompts }),
		});
		try {
			const { instanceId, prompt } = await launchPoemProcess(harness);
			await waitForValue(
				() => harness.process(instanceId).snapshot().leafOutcomes,
				(snapshots) => snapshots.length === 1,
			);
			await runPoemAutoReview(harness, instanceId);
			const snapshots = await waitForValue(
				() => harness.process(instanceId).snapshot().leafOutcomes,
				(items) => items.length === 2,
			);
			expect(snapshots[0]?.leafEntryId).not.toBe(snapshots[1]?.leafEntryId);
			if (script.outcome === "leave_feedback") {
				expect(reviewPrompts).toHaveLength(1);
				expect(reviewPrompts[0]?.promptText).toContain("Poem draft to review:");
				expect(reviewPrompts[0]?.promptText).toContain(poemMarkdown);
			}
			expect(snapshots[1]).toEqual(
				expect.objectContaining({
					fallbackMarkdown: `${poemMarkdown}\n\n${suffix}`,
					props: {
						prompt,
						markdown: poemMarkdown,
						title: "Berlin Release",
						stanzas: [
							["Tin rooftops glimmer", "Release wires sing"],
							["Deploy lights gather", "At the edge of spring"],
						],
						review: { outcome: script.outcome, summary: script.summary, feedback },
					},
				}),
			);
		} finally {
			await harness.close();
		}
	}, 15_000);

	it("preserves historical poem snapshots across a human revision loop", async () => {
		const harness = await createShowcaseHarness({
			script: createPoemSnapshotScript([
				"# First Platform\n\nTin rooftops glimmer<br>Signals softly rise",
				"# Brighter Platform\n\nTin rooftops shimmer<br>Signals warm the skies",
			]),
		});

		try {
			const { instanceId, prompt } = await launchPoemProcess(harness);
			const initial = await waitForValue(
				() => harness.process(instanceId).snapshot().leafOutcomes,
				(snapshots) => snapshots.length === 1,
			);
			expect(initial[0]).toEqual(
				expect.objectContaining({
					rendererId: "@leitwerk-dev/showcase-processes:poem_creator_process.leaf_outcome",
					schemaVersion: 1,
					fallbackMarkdown: "# First Platform\n\nTin rooftops glimmer<br>Signals softly rise",
					props: {
						prompt,
						markdown: "# First Platform\n\nTin rooftops glimmer<br>Signals softly rise",
						title: "First Platform",
						stanzas: [["Tin rooftops glimmer", "Signals softly rise"]],
					},
				}),
			);

			const actionResponse = await http(
				harness,
				`/api/processes/${encodeURIComponent(instanceId)}/actions/request_poem_revision`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						input: {
							message: "Keep the setting, but make the ending warmer and more optimistic.",
						},
					}),
				},
			);
			expect(actionResponse.status).toBe(200);

			const snapshots = await waitForValue(
				() => harness.process(instanceId).snapshot().leafOutcomes,
				(items) => items.length === 2,
			);
			expect(snapshots.map((snapshot) => snapshot.props?.title)).toEqual([
				"First Platform",
				"Brighter Platform",
			]);
		} finally {
			await harness.close();
		}
	}, 15_000);
});

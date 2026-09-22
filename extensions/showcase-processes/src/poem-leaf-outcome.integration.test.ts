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
	it.skip("captures structured poem renderer props from the real poem creator process", async () => {
		const harness = await createShowcaseHarness({
			script: createPoemSnapshotScript([
				"# Berlin Release\n\nTin rooftops glimmer<br>Release wires sing\n\nDeploy lights gather<br>At the edge of spring",
			]),
		});

		try {
			const { instanceId, prompt } = await launchPoemProcess(harness);
			await waitForValue(
				() => harness.process(instanceId).snapshot().leafOutcomes,
				(snapshots) => snapshots.length === 1,
			);
			await waitForValue(
				() => harness.process(instanceId).snapshot().process,
				(process) =>
					process?.selectedTurnId === "poem_review" && process.lifecycleStatus === "waiting",
			);

			expect(harness.process(instanceId).snapshot().leafOutcomes).toEqual([
				expect.objectContaining({
					rendererId: "@leitwerk-dev/showcase-processes:poem_creator_process.leaf_outcome",
					schemaVersion: 1,
					fallbackMarkdown:
						"# Berlin Release\n\nTin rooftops glimmer<br>Release wires sing\n\nDeploy lights gather<br>At the edge of spring",
					props: {
						prompt,
						markdown:
							"# Berlin Release\n\nTin rooftops glimmer<br>Release wires sing\n\nDeploy lights gather<br>At the edge of spring",
						title: "Berlin Release",
						stanzas: [
							["Tin rooftops glimmer", "Release wires sing"],
							["Deploy lights gather", "At the edge of spring"],
						],
					},
				}),
			]);
		} finally {
			await harness.close();
		}
	});

	it("captures a review-leaf snapshot with the poem plus LLM findings", async () => {
		const reviewPrompts: ReviewPromptCapture[] = [];
		const poemMarkdown =
			"# Berlin Release\n\nTin rooftops glimmer<br>Release wires sing\n\nDeploy lights gather<br>At the edge of spring";
		const harness = await createShowcaseHarness({
			script: createPoemSnapshotScript(
				[poemMarkdown],
				{
					outcome: "leave_feedback",
					summary: "The poem needs revision before publication.",
					feedback: "Sharpen the closing image and brighten the rhythm.",
				},
				{ reviewPrompts },
			),
		});

		try {
			const { instanceId } = await launchPoemProcess(harness);
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
			expect(reviewPrompts).toHaveLength(1);
			expect(reviewPrompts[0]?.promptText).toContain("Poem draft to review:");
			expect(reviewPrompts[0]?.promptText).toContain(poemMarkdown);
			expect(snapshots[1]).toEqual(
				expect.objectContaining({
					fallbackMarkdown:
						"# Berlin Release\n\nTin rooftops glimmer<br>Release wires sing\n\nDeploy lights gather<br>At the edge of spring\n\n## Review\n\nThe poem needs revision before publication.\n\n## Review feedback\n\nSharpen the closing image and brighten the rhythm.",
					props: {
						prompt: "Write a short poem about Berlin rooftops and release trains at dusk.",
						markdown:
							"# Berlin Release\n\nTin rooftops glimmer<br>Release wires sing\n\nDeploy lights gather<br>At the edge of spring",
						title: "Berlin Release",
						stanzas: [
							["Tin rooftops glimmer", "Release wires sing"],
							["Deploy lights gather", "At the edge of spring"],
						],
						review: {
							outcome: "leave_feedback",
							summary: "The poem needs revision before publication.",
							feedback: "## Review feedback\n\nSharpen the closing image and brighten the rhythm.",
						},
					},
				}),
			);
		} finally {
			await harness.close();
		}
	}, 15_000);

	it("captures a review-leaf snapshot with the poem plus an LLM no-issues opinion", async () => {
		const harness = await createShowcaseHarness({
			script: createPoemSnapshotScript(
				[
					"# Berlin Release\n\nTin rooftops glimmer<br>Release wires sing\n\nDeploy lights gather<br>At the edge of spring",
				],
				{
					outcome: "no_issues",
					summary: "The revised poem is ready to publish.",
				},
			),
		});

		try {
			const { instanceId } = await launchPoemProcess(harness);
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
			expect(snapshots[1]).toEqual(
				expect.objectContaining({
					fallbackMarkdown:
						"# Berlin Release\n\nTin rooftops glimmer<br>Release wires sing\n\nDeploy lights gather<br>At the edge of spring\n\n## LLM Opinion\n\nThe revised poem is ready to publish.",
					props: {
						prompt: "Write a short poem about Berlin rooftops and release trains at dusk.",
						markdown:
							"# Berlin Release\n\nTin rooftops glimmer<br>Release wires sing\n\nDeploy lights gather<br>At the edge of spring",
						title: "Berlin Release",
						stanzas: [
							["Tin rooftops glimmer", "Release wires sing"],
							["Deploy lights gather", "At the edge of spring"],
						],
						review: {
							outcome: "no_issues",
							summary: "The revised poem is ready to publish.",
							feedback: null,
						},
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
			const { instanceId } = await launchPoemProcess(harness);
			await waitForValue(
				() => harness.process(instanceId).snapshot().leafOutcomes,
				(snapshots) => snapshots.length === 1,
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

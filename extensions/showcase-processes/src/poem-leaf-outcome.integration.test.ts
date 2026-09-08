import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
} from "@leitwerk-dev/process-sdk";
import type { LeitwerkConfig } from "@leitwerk-dev/server";
import { postImmediateLaunchRequest } from "@leitwerk-dev/test-support";
import { createIntegrationHarness, waitForValue } from "@leitwerk-dev/test-support/integration";
import {
	createInProcessWorkerSpawn,
	StubPiTreeHandleFactory,
} from "@leitwerk-dev/test-support/worker-testing";
import { describe, expect, it } from "vitest";
import singlePromptExtension from "./index.js";

const poemSnapshotFixtureProviderExtension = {
	manifest: { id: "poem-snapshot-fixture-provider", version: "1.0.0" },
	modelProviders: defineModelProviders((rawConfig) => [
		{
			definition: defineModelProvider({
				id: "poem-snapshot-fixture-provider",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("poem-snapshot-fixture-provider"),
				server: builtinPiProvider("poem-snapshot-fixture-provider"),
				models: () => [{ modelId: "fixture-model", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
	]),
};

const extensionCatalog = buildExtensionCatalogFromModules([
	singlePromptExtension,
	poemSnapshotFixtureProviderExtension,
]);

function applyModelProfileConfig(config: LeitwerkConfig): void {
	config.pi.model_profiles = [
		{
			id: "claude_fast",
			provider: "poem-snapshot-fixture-provider",
			model_id: "fixture-model",
		},
	];
}

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
	identifiedPrompt: {
		content: string;
		details: unknown;
	} | null;
}

function findIdentifiedReviewPrompt(piFactory: StubPiTreeHandleFactory) {
	const entries = new Map<
		string,
		ReturnType<StubPiTreeHandleFactory["sessions"][number]["getBranch"]>[number]
	>();
	for (const session of piFactory.sessions) {
		const visit = (nodes: ReturnType<typeof session.getTree>): void => {
			for (const node of nodes) {
				entries.set(node.entry.id, node.entry);
				visit(node.children);
			}
		};
		visit(session.getTree());
	}
	const entry = [...entries.values()].findLast(
		(candidate) =>
			candidate.type === "custom_message" &&
			candidate.customType === "leitwerk" &&
			typeof candidate.content === "string" &&
			candidate.content.includes("Poem draft to review:"),
	);
	return entry?.type === "custom_message" && typeof entry.content === "string"
		? { content: entry.content, details: entry.details }
		: null;
}

function createPoemSnapshotSpawn(
	markdowns: readonly string[],
	reviewScript?: ReviewScript,
	options: { reviewPrompts?: ReviewPromptCapture[] } = {},
) {
	let draftIndex = 0;
	let piFactory: StubPiTreeHandleFactory;
	piFactory = new StubPiTreeHandleFactory({
		toolCallScriptResolver({ tools, promptText }) {
			const turnTools = tools.filter((tool) => tool.name !== "upload_result_images");
			const toolNames = new Set(turnTools.map((tool) => tool.name));
			if (reviewScript?.outcome === "leave_feedback" && toolNames.has("leave_feedback")) {
				options.reviewPrompts?.push({
					promptText,
					identifiedPrompt: findIdentifiedReviewPrompt(piFactory),
				});
				return {
					toolName: "leave_feedback",
					args: {
						summary: reviewScript.summary,
						message: `## Review feedback\n\n${reviewScript.feedback}`,
					},
				};
			}
			if (reviewScript?.outcome === "no_issues" && toolNames.has("no_issues")) {
				options.reviewPrompts?.push({
					promptText,
					identifiedPrompt: findIdentifiedReviewPrompt(piFactory),
				});
				return {
					toolName: "no_issues",
					args: {
						review: `## Review\n\n${reviewScript.summary}`,
						summary: reviewScript.summary,
					},
				};
			}
			if ((toolNames.has("markdown_result") && turnTools.length === 1) || turnTools.length === 0) {
				const markdown =
					markdowns[Math.min(draftIndex, markdowns.length - 1)] ?? "# Untitled\n\nNo poem";
				draftIndex += 1;
				return {
					toolName: "markdown_result",
					args: { markdown },
				};
			}
			return undefined;
		},
	});
	return createInProcessWorkerSpawn({ extensionCatalog, piFactory });
}

async function launchPoemProcess(harness: Awaited<ReturnType<typeof createIntegrationHarness>>) {
	const prompt = "Write a short poem about Berlin rooftops and release trains at dusk.";
	const response = await postImmediateLaunchRequest(
		`${harness.address}/api/launchers/poem_creator_process.poem_creator_ui/launch-runs`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				launcherInput: {
					prompt,
				},
				modelConfig: {
					defaultModelProfileId: "claude_fast",
				},
			}),
		},
	);
	expect(response.status).toBe(201);
	const body = (await response.json()) as { process: { id: string } };
	return {
		instanceId: body.process.id,
		prompt,
	};
}

async function runPoemAutoReview(
	harness: Awaited<ReturnType<typeof createIntegrationHarness>>,
	instanceId: string,
) {
	const response = await fetch(
		`${harness.address}/api/processes/${encodeURIComponent(instanceId)}/actions/run_poem_auto_review`,
		{ method: "POST" },
	);
	expect(response.status).toBe(200);
}

describe("poem leaf outcome adoption", () => {
	it.skip("captures structured poem renderer props from the real poem creator process", async () => {
		const harness = await createIntegrationHarness({
			extensionCatalog,
			configOverride: applyModelProfileConfig,
			appOverrides: {
				localWorkerSpawnImpl: createPoemSnapshotSpawn([
					"# Berlin Release\n\nTin rooftops glimmer<br>Release wires sing\n\nDeploy lights gather<br>At the edge of spring",
				]),
			},
		});

		try {
			const { instanceId, prompt } = await launchPoemProcess(harness);
			await waitForValue(
				() => harness.ctx.deps.leafOutcomeSnapshots.listByInstance(instanceId),
				(snapshots) => snapshots.length === 1,
			);
			await waitForValue(
				() => harness.ctx.deps.processes.getById(instanceId),
				(process) =>
					process?.selectedTurnId === "poem_review" && process.lifecycleStatus === "waiting",
			);

			expect(harness.ctx.deps.leafOutcomeSnapshots.listByInstance(instanceId)).toEqual([
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
			await harness.ctx.app.close();
		}
	});

	it("captures a review-leaf snapshot with the poem plus LLM findings", async () => {
		const reviewPrompts: ReviewPromptCapture[] = [];
		const poemMarkdown =
			"# Berlin Release\n\nTin rooftops glimmer<br>Release wires sing\n\nDeploy lights gather<br>At the edge of spring";
		const harness = await createIntegrationHarness({
			extensionCatalog,
			configOverride: applyModelProfileConfig,
			appOverrides: {
				localWorkerSpawnImpl: createPoemSnapshotSpawn(
					[poemMarkdown],
					{
						outcome: "leave_feedback",
						summary: "The poem needs revision before publication.",
						feedback: "Sharpen the closing image and brighten the rhythm.",
					},
					{ reviewPrompts },
				),
			},
		});

		try {
			const { instanceId } = await launchPoemProcess(harness);
			await waitForValue(
				() => harness.ctx.deps.leafOutcomeSnapshots.listByInstance(instanceId),
				(snapshots) => snapshots.length === 1,
			);

			await runPoemAutoReview(harness, instanceId);

			const snapshots = await waitForValue(
				() => harness.ctx.deps.leafOutcomeSnapshots.listByInstance(instanceId),
				(items) => items.length === 2,
			);
			expect(snapshots[0]?.leafEntryId).not.toBe(snapshots[1]?.leafEntryId);
			expect(reviewPrompts).toHaveLength(1);
			expect(reviewPrompts[0]?.promptText).toBe("");
			expect(reviewPrompts[0]?.identifiedPrompt).toMatchObject({
				content: expect.stringContaining("Poem draft to review:"),
				details: {
					kind: "turn_prompt",
					startRecordId: expect.any(String),
					purpose: "kickoff",
				},
			});
			expect(reviewPrompts[0]?.identifiedPrompt?.content).toContain(poemMarkdown);
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
			await harness.ctx.app.close();
		}
	}, 15_000);

	it("captures a review-leaf snapshot with the poem plus an LLM no-issues opinion", async () => {
		const harness = await createIntegrationHarness({
			extensionCatalog,
			configOverride: applyModelProfileConfig,
			appOverrides: {
				localWorkerSpawnImpl: createPoemSnapshotSpawn(
					[
						"# Berlin Release\n\nTin rooftops glimmer<br>Release wires sing\n\nDeploy lights gather<br>At the edge of spring",
					],
					{
						outcome: "no_issues",
						summary: "The revised poem is ready to publish.",
					},
				),
			},
		});

		try {
			const { instanceId } = await launchPoemProcess(harness);
			await waitForValue(
				() => harness.ctx.deps.leafOutcomeSnapshots.listByInstance(instanceId),
				(snapshots) => snapshots.length === 1,
			);

			await runPoemAutoReview(harness, instanceId);

			const snapshots = await waitForValue(
				() => harness.ctx.deps.leafOutcomeSnapshots.listByInstance(instanceId),
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
			await harness.ctx.app.close();
		}
	}, 15_000);

	it("preserves historical poem snapshots across a human revision loop", async () => {
		const harness = await createIntegrationHarness({
			extensionCatalog,
			configOverride: applyModelProfileConfig,
			appOverrides: {
				localWorkerSpawnImpl: createPoemSnapshotSpawn([
					"# First Platform\n\nTin rooftops glimmer<br>Signals softly rise",
					"# Brighter Platform\n\nTin rooftops shimmer<br>Signals warm the skies",
				]),
			},
		});

		try {
			const { instanceId } = await launchPoemProcess(harness);
			await waitForValue(
				() => harness.ctx.deps.leafOutcomeSnapshots.listByInstance(instanceId),
				(snapshots) => snapshots.length === 1,
			);

			const actionResponse = await fetch(
				`${harness.address}/api/processes/${encodeURIComponent(instanceId)}/actions/request_poem_revision`,
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
				() => harness.ctx.deps.leafOutcomeSnapshots.listByInstance(instanceId),
				(items) => items.length === 2,
			);
			expect(snapshots.map((snapshot) => snapshot.props?.title)).toEqual([
				"First Platform",
				"Brighter Platform",
			]);
		} finally {
			await harness.ctx.app.close();
		}
	}, 15_000);
});

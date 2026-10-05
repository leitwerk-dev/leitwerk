import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionIntegrationProcess } from "@leitwerk-dev/test-support/integration";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { createShowcaseHarness } from "./testing/harness.js";

async function createLeaveFeedbackReviewHarness() {
	return createShowcaseHarness({
		script(_id, _prompt, observation) {
			if (observation.tools.some((tool) => tool.name === "leave_feedback"))
				return {
					tools: [
						{
							name: "leave_feedback",
							arguments: {
								summary: "The poem needs revision before publication",
								message:
									"## Review feedback\n\nStrengthen the theme connection, tighten the rhythm, and end with a more vivid final image.",
							},
						},
					],
				};
			return {
				tools: [
					{
						name: "markdown_result",
						arguments: {
							markdown:
								"# Cloud Dusk\n\nEvening servers hum in amber light,\nScaled dreams unfolding into night.",
						},
					},
				],
			};
		},
	});
}

function launchPoem(prompt: string, defaultModelProfileId = "local_qwen", runtime = harness) {
	return runtime.launch(
		"poem_creator_process.poem_creator_ui",
		{ prompt },
		{ defaultModelProfileId },
	);
}

function waitForReview(
	poem: ExtensionIntegrationProcess,
	turnId = "poem_review",
	counts: Record<string, number> = {},
) {
	return poem.waitFor(
		({ process, turns }) =>
			process.selectedTurnId === turnId &&
			process.lifecycleStatus === "waiting" &&
			Object.entries(counts).every(
				([id, count]) => turns.filter((turn) => turn.turnId === id).length === count,
			),
	);
}

async function processActions(poem: ExtensionIntegrationProcess, runtime = harness) {
	const response = await runtime.request({ url: `/api/processes/${poem.id}/actions` });
	expect(response.statusCode).toBe(200);
	return response.json<{ actions: { id: string }[] }>().actions;
}

async function launchFeedbackReview(prompt: string) {
	const issuesHarness = await createLeaveFeedbackReviewHarness();
	onTestFinished(() => issuesHarness.close());
	const poem = await launchPoem(prompt, "claude_fast", issuesHarness);
	await waitForReview(poem);
	expect((await poem.action("run_poem_auto_review")).statusCode).toBe(200);
	const review = await waitForReview(poem, "poem_review_feedback");
	return { issuesHarness, poem, review };
}

function reviewToolNames(poem: ExtensionIntegrationProcess) {
	const { turns, events } = poem.snapshot();
	const reviewIds = new Set(
		turns.filter((turn) => turn.turnId === "review_poem_draft").map((turn) => turn.id),
	);
	return events
		.filter(
			(event) =>
				event.eventType === "pi.tool.call" && reviewIds.has(String(event.data.turnRecordId ?? "")),
		)
		.map((event) => String(event.data.name));
}

let harness: Awaited<ReturnType<typeof createShowcaseHarness>>;

beforeAll(async () => {
	harness = await createShowcaseHarness();
});

afterAll(async () => {
	await harness.close();
});

describe("poem creator extension", () => {
	it("lists only the poem launcher and resolves its defaults", async () => {
		const response = await harness.request({ url: "/api/launchers" });
		expect(response.statusCode).toBe(200);
		expect((await response.json()).launchers).toEqual([
			expect.objectContaining({
				id: "poem_creator_process.poem_creator_ui",
				processId: "poem_creator_process",
				label: "Poem Creator",
			}),
		]);
		const poemDefaultsResponse = await harness.request({
			url: "/api/launchers/poem_creator_process.poem_creator_ui/defaults",
		});
		const poemDefaultsBody = poemDefaultsResponse.json();
		expect(poemDefaultsResponse.statusCode).toBe(200);
		expect(poemDefaultsBody.defaults.prompt).toEqual(expect.stringMatching(/\S/));
		expect(poemDefaultsBody.modelConfig).toEqual({
			defaultModelProfileId: null,
			turnConfigs: {},
		});
	});

	it("triggers poem revisions from the configured poem-review file and removes the file", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "o2-poem-review-trigger-"));
		onTestFinished(() => rm(dir, { recursive: true, force: true }));
		const poemReviewPath = path.join(dir, "poem_review");
		const fileTriggerHarness = await createShowcaseHarness({
			extensionConfig: {
				"showcase-processes": { file_triggers: { poem_review_path: poemReviewPath } },
			},
		});
		onTestFinished(() => fileTriggerHarness.close());
		const poem = await launchPoem(
			"Write a short poem about rain over Berlin rooftops.",
			"local_qwen",
			fileTriggerHarness,
		);
		await waitForReview(poem);
		await poem.waitFor(({ events }) =>
			events.some(
				(event) =>
					event.eventType === "external_source_armed" &&
					event.data.armingId === "poem_review:poem_review_file",
			),
		);

		const detailResponse = await fileTriggerHarness.request({
			url: `/api/processes/${poem.id}`,
		});
		const detailBody = detailResponse.json();
		expect(detailResponse.statusCode).toBe(200);
		expect(detailBody.selectedTurn).toMatchObject({
			turnId: "poem_review",
			kind: "human",
			externalTriggers: [
				expect.objectContaining({
					id: "poem_review:poem_review_file",
					externalActionId: "poem_review_file",
					kind: "@leitwerk-dev/showcase-processes.file.instruction",
				}),
			],
		});
		await writeFile(poemReviewPath, "Make the imagery softer and more twilight-heavy.", "utf8");

		const afterRevision = await poem.waitFor(
			({ turns, annotations }) =>
				turns.filter((turn) => turn.turnId === "draft_poem").length >= 2 &&
				turns.some((turn) => turn.turnType === "external") &&
				annotations.some((annotation) => annotation.annotationType === "external_trigger") &&
				!existsSync(poemReviewPath),
		);
		expect(afterRevision.turns.filter((turn) => turn.turnId === "draft_poem")).toHaveLength(2);
		expect(afterRevision.turns.filter((turn) => turn.turnType === "external")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ turnId: "poem_review", status: "succeeded" }),
			]),
		);
		expect(afterRevision.annotations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					annotationType: "external_trigger",
					payload: expect.objectContaining({
						externalActionId: "poem_review_file",
						armingId: "poem_review:poem_review_file",
					}),
				}),
			]),
		);
	});

	it("launches poem creator with the default prompt, creates a workspace, and auto-accepts no_issues reviews without redrafting", async () => {
		const defaultsResponse = await harness.request({
			url: "/api/launchers/poem_creator_process.poem_creator_ui/defaults",
		});
		const defaultsBody = defaultsResponse.json();
		expect(defaultsResponse.statusCode).toBe(200);
		const poem = await launchPoem("", "claude_fast");
		expect(poem.snapshot().process).toMatchObject({
			processId: "poem_creator_process",
			defaultModelProfileId: "claude_fast",
		});
		const firstHumanReview = await waitForReview(poem);
		expect(firstHumanReview.process).toMatchObject({ lifecycleStatus: "waiting" });
		expect(JSON.parse(firstHumanReview.process.paramsJson ?? "{}")).toMatchObject({
			prompt: defaultsBody.defaults.prompt,
		});
		expect(existsSync(firstHumanReview.workspaceRoot)).toBe(true);

		const expectedActions = expect.arrayContaining([
			expect.objectContaining({
				id: "complete_poem",
				label: "Complete poem",
				supportsScheduling: false,
				supportsNextTurnModelOverride: false,
				preview: expect.objectContaining({ kind: "terminal" }),
			}),
			expect.objectContaining({
				id: "request_poem_revision",
				label: "Request revision",
				supportsScheduling: true,
				supportsNextTurnModelOverride: true,
				preview: expect.objectContaining({ turnId: "draft_poem", turnKind: "llm" }),
			}),
			expect.objectContaining({
				id: "run_poem_auto_review",
				label: "Run automated review",
				supportsScheduling: true,
				supportsNextTurnModelOverride: true,
				preview: expect.objectContaining({ turnId: "review_poem_draft", turnKind: "llm" }),
			}),
		]);
		expect(await processActions(poem)).toEqual(expectedActions);
		const firstTurnRecords = firstHumanReview.turns;
		expect(firstTurnRecords).toHaveLength(1);
		expect(firstTurnRecords[0]).toMatchObject({
			turnId: "draft_poem",
			status: "succeeded",
			pathType: "primary",
		});
		expect(firstTurnRecords[0]?.turnResultMarkdown).toEqual(expect.any(String));
		expect(firstTurnRecords[0]?.turnResultMarkdown?.trim().length).toBeGreaterThan(0);
		expect((await poem.action("run_poem_auto_review")).statusCode).toBe(200);

		const afterAutoAcceptedReview = await poem.waitFor(
			({ process, turns }) =>
				process.lifecycleStatus === "waiting" &&
				process.selectedTurnId === "poem_review" &&
				turns.filter((turn) => turn.turnId === "draft_poem").length === 1 &&
				JSON.parse(process.stateJson ?? "null")?.latestReviewOutcome === "no_issues",
		);
		expect(afterAutoAcceptedReview.process).toMatchObject({ lifecycleStatus: "waiting" });
		expect(JSON.parse(afterAutoAcceptedReview.process.stateJson ?? "null")).toMatchObject({
			latestReviewOutcome: "no_issues",
			latestReviewMarkdown: null,
			latestReviewSummary: expect.any(String),
		});
		expect(afterAutoAcceptedReview.inputs).toHaveLength(0);
		expect(reviewToolNames(poem)).toEqual(["no_issues"]);

		const reviewActions = await processActions(poem);
		expect(reviewActions).toEqual(expectedActions);
		expect(
			reviewActions.filter((action) =>
				["accept_poem_review", "request_poem_review_changes"].includes(action.id),
			),
		).toEqual([]);
		const reviewTurnRecords = afterAutoAcceptedReview.turns;
		expect(reviewTurnRecords).toHaveLength(3);
		expect(reviewTurnRecords).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					turnId: "poem_review",
					turnType: "human",
					status: "succeeded",
					pathType: "primary",
				}),
				expect.objectContaining({
					turnId: "review_poem_draft",
					turnType: "llm",
					status: "succeeded",
					pathType: "root_branch",
				}),
			]),
		);
		expect(reviewTurnRecords.some((turn) => turn.turnId === "poem_review_feedback")).toBe(false);
		expect((await poem.action("complete_poem")).statusCode).toBe(200);
		const completed = await poem.waitFor(({ process }) => process.lifecycleStatus === "completed");
		expect(completed.process).toMatchObject({ lifecycleStatus: "completed" });
	});

	it("schedules poem review-loop actions while rejecting terminal poem completion scheduling", async () => {
		const poem = await launchPoem("Write a short poem about sunrise over the city skyline.");
		await waitForReview(poem);
		const runReviewAt = new Date(Date.now() + 60_000).toISOString();
		const reviewScheduleResponse = await harness.request({
			url: `/api/processes/${poem.id}/actions/run_poem_auto_review`,
			method: "POST",
			payload: {
				nextTurnModelProfileId: "claude_fast",
				schedule: { mode: "once", runAt: runReviewAt },
			},
		});
		const reviewScheduleBody = await reviewScheduleResponse.json();
		expect(reviewScheduleResponse.statusCode).toBe(201);
		expect(reviewScheduleBody.scheduledAction).toMatchObject({
			actionId: "run_poem_auto_review",
			nextTurnModelProfileId: "claude_fast",
			action: {
				supportsScheduling: true,
				supportsNextTurnModelOverride: true,
				preview: expect.objectContaining({ turnId: "review_poem_draft", turnKind: "llm" }),
			},
		});
		await harness.request({
			url: `/api/future-executions/${reviewScheduleBody.scheduledAction.id}`,
			method: "DELETE",
		});
		const scheduleResponse = await harness.request({
			url: `/api/processes/${poem.id}/actions/complete_poem`,
			method: "POST",
			payload: { schedule: { mode: "once", runAt: new Date(Date.now() + 120_000).toISOString() } },
		});
		expect(scheduleResponse.statusCode).toBe(400);
		expect(scheduleResponse.json().code).toBe("action_not_schedulable");
	});

	it("sends accepted leave_feedback review back to the primary branch", async () => {
		const {
			issuesHarness,
			poem,
			review: humanReviewOfReview,
		} = await launchFeedbackReview("Write a short poem about cloud software under an evening sky.");
		expect(JSON.parse(humanReviewOfReview.process.stateJson ?? "null")).toMatchObject({
			latestReviewOutcome: "leave_feedback",
			latestReviewMarkdown: expect.any(String),
		});
		expect(reviewToolNames(poem)).toEqual(["leave_feedback"]);

		const processDetailResponse = await issuesHarness.request({
			url: `/api/processes/${poem.id}`,
		});
		const processDetailBody = processDetailResponse.json();
		expect(processDetailResponse.statusCode).toBe(200);
		expect(processDetailBody.toolRenderers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolName: "leave_feedback",
					fields: [
						expect.objectContaining({ kind: "plaintext", path: "message", source: "arguments" }),
					],
				}),
			]),
		);
		expect(await processActions(poem, issuesHarness)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "accept_poem_review", label: "Accept review" }),
				expect.objectContaining({
					id: "request_poem_review_changes",
					label: "Request review changes",
					supportsScheduling: true,
					supportsNextTurnModelOverride: true,
					preview: expect.objectContaining({ turnId: "review_poem_draft", turnKind: "llm" }),
				}),
				expect.objectContaining({
					id: "dismiss_poem_review",
					label: "Dismiss review",
					supportsScheduling: false,
					supportsNextTurnModelOverride: false,
					preview: expect.objectContaining({ turnId: "poem_review", turnKind: "human" }),
				}),
			]),
		);
		expect(humanReviewOfReview.turns).toHaveLength(3);
		expect((await poem.action("accept_poem_review")).statusCode).toBe(200);
		const afterAcceptedReview = await waitForReview(poem, "poem_review", { draft_poem: 2 });
		expect(afterAcceptedReview.process).toMatchObject({ lifecycleStatus: "waiting" });
		expect(afterAcceptedReview.inputs).toEqual([]);
		const acceptedReviewDrafts = afterAcceptedReview.turns.filter(
			(turn) => turn.turnId === "draft_poem",
		);
		expect(acceptedReviewDrafts).toHaveLength(2);
		expect(acceptedReviewDrafts[1]).toMatchObject({
			pathType: "primary",
			forkPiEntryId: acceptedReviewDrafts[0]?.resultPiEntryId,
		});
		expect(afterAcceptedReview.turns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					turnId: "poem_review_feedback",
					turnType: "human",
					status: "succeeded",
				}),
			]),
		);
	});

	it("supports a human revision loop for poem creator before returning to review", async () => {
		const poem = await launchPoem("Write a short poem about crafting cloud software at dusk.");
		await waitForReview(poem);
		expect(
			(
				await poem.action("request_poem_revision", {
					message: "Make it calmer, more twilight-colored, and a little more precise.",
				})
			).statusCode,
		).toBe(200);
		const rerun = await waitForReview(poem, "poem_review", { draft_poem: 2 });
		expect(rerun.process).toMatchObject({
			lifecycleStatus: "waiting",
			defaultModelProfileId: "local_qwen",
		});
		const draftTurnRecords = rerun.turns.filter((turn) => turn.turnId === "draft_poem");
		expect(draftTurnRecords).toHaveLength(2);
		expect(draftTurnRecords[1]).toMatchObject({
			pathType: "primary",
			forkPiEntryId: draftTurnRecords[0]?.resultPiEntryId,
		});
		expect(rerun.turns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					turnId: "poem_review",
					turnType: "human",
					status: "succeeded",
				}),
			]),
		);
	});

	it("continues llm review on the same review branch when a human requests review changes", async () => {
		const {
			poem,
			review: { turns },
		} = await launchFeedbackReview("Write a short poem about rain over Berlin rooftops.");
		const firstDraft = turns.find((turn) => turn.turnId === "draft_poem");
		const firstReview = turns.filter((turn) => turn.turnId === "review_poem_draft").at(-1);
		expect(firstReview).toMatchObject({
			pathType: "root_branch",
			forkPiEntryId: firstDraft?.resultPiEntryId,
		});
		expect(
			(
				await poem.action("request_poem_review_changes", {
					message: "Keep the same review branch, but make the review sharper and more concrete.",
				})
			).statusCode,
		).toBe(200);
		const afterRerun = await waitForReview(poem, "poem_review_feedback", {
			review_poem_draft: 2,
			draft_poem: 1,
		});
		const secondReview = afterRerun.turns
			.filter((turn) => turn.turnId === "review_poem_draft")
			.at(-1);
		expect(secondReview).toMatchObject({
			turnId: "review_poem_draft",
			status: "succeeded",
			pathType: "root_branch",
			forkPiEntryId: firstReview?.resultPiEntryId,
		});
	});
});

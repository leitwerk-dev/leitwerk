import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { createShowcaseHarness, http, launchProcess } from "./testing/harness.js";

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
async function createFileTriggerHarness(poemReviewPath: string) {
	return createShowcaseHarness({
		extensionConfig: {
			"showcase-processes": { file_triggers: { poem_review_path: poemReviewPath } },
		},
	});
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
		const response = await http(harness, "/api/launchers");
		expect(response.status).toBe(200);
		expect((await response.json()).launchers).toEqual([
			expect.objectContaining({
				id: "poem_creator_process.poem_creator_ui",
				processId: "poem_creator_process",
				label: "Poem Creator",
			}),
		]);
		const poemDefaultsResponse = await http(
			harness,
			`/api/launchers/poem_creator_process.poem_creator_ui/defaults`,
		);
		const poemDefaultsBody = await poemDefaultsResponse.json();
		expect(poemDefaultsResponse.status).toBe(200);
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
		const fileTriggerHarness = await createFileTriggerHarness(poemReviewPath);
		try {
			const launched = await launchProcess(
				fileTriggerHarness,
				"poem_creator_process.poem_creator_ui",
				{ prompt: "Write a short poem about rain over Berlin rooftops." },
				"local_qwen",
			);

			await waitForValue(
				() => fileTriggerHarness.process(launched.id).snapshot().process,
				(value) => value?.selectedTurnId === "poem_review" && value?.lifecycleStatus === "waiting",
			);
			await waitForValue(
				() => fileTriggerHarness.process(launched.id).snapshot().events,
				(events) =>
					events.some(
						(event) =>
							event.eventType === "external_source_armed" &&
							event.data.armingId === "poem_review:poem_review_file",
					),
			);

			const detailResponse = await http(fileTriggerHarness, `/api/processes/${launched.id}`);
			const detailBody = await detailResponse.json();
			expect(detailResponse.status).toBe(200);
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

			const afterRevision = await waitForValue(
				() => ({
					process: fileTriggerHarness.process(launched.id).snapshot().process,
					turnRecords: fileTriggerHarness.process(launched.id).snapshot().turns,
					annotations: fileTriggerHarness.process(launched.id).snapshot().annotations,
					fileRemoved: !existsSync(poemReviewPath),
				}),
				(value) =>
					value.turnRecords.filter((turnRecord) => turnRecord.turnId === "draft_poem").length >=
						2 &&
					value.turnRecords.some((turnRecord) => turnRecord.turnType === "external") &&
					value.annotations.some(
						(annotation) => annotation.annotationType === "external_trigger",
					) &&
					value.fileRemoved,
			);
			expect(
				afterRevision.turnRecords.filter((turnRecord) => turnRecord.turnId === "draft_poem"),
			).toHaveLength(2);
			expect(
				afterRevision.turnRecords.filter((turnRecord) => turnRecord.turnType === "external"),
			).toEqual(
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
		} finally {
			await fileTriggerHarness.close();
		}
	});

	it("launches poem creator with the default prompt, creates a workspace, and auto-accepts no_issues reviews without redrafting", async () => {
		const defaultsResponse = await http(
			harness,
			`/api/launchers/poem_creator_process.poem_creator_ui/defaults`,
		);
		const defaultsBody = await defaultsResponse.json();
		expect(defaultsResponse.status).toBe(200);

		const launched = await launchProcess(
			harness,
			"poem_creator_process.poem_creator_ui",
			{ prompt: "" },
			"claude_fast",
		);
		expect(launched).toMatchObject({
			processId: "poem_creator_process",
			defaultModelProfileId: "claude_fast",
		});

		const firstHumanReview = await waitForValue(
			() => harness.process(launched.id).snapshot().process,
			(value) => {
				if (!value || value.lifecycleStatus !== "waiting") {
					return false;
				}
				return value.selectedTurnId === "poem_review";
			},
		);
		expect(firstHumanReview).toMatchObject({
			lifecycleStatus: "waiting",
		});
		expect(JSON.parse(firstHumanReview?.paramsJson ?? "{}")).toMatchObject({
			prompt: defaultsBody.defaults.prompt,
		});

		const workspaceRoot = harness.process(launched.id).snapshot().workspaceRoot;
		expect(existsSync(workspaceRoot)).toBe(true);

		const initialActionsResponse = await http(harness, `/api/processes/${launched.id}/actions`);
		const initialActionsBody = await initialActionsResponse.json();
		expect(initialActionsResponse.status).toBe(200);
		expect(initialActionsBody.actions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "complete_poem", label: "Complete poem" }),
				expect.objectContaining({ id: "request_poem_revision", label: "Request revision" }),
				expect.objectContaining({ id: "run_poem_auto_review", label: "Run automated review" }),
			]),
		);
		const completePoemAction = initialActionsBody.actions.find(
			(action: { id: string }) => action.id === "complete_poem",
		);
		const requestRevisionAction = initialActionsBody.actions.find(
			(action: { id: string }) => action.id === "request_poem_revision",
		);
		const autoReviewAction = initialActionsBody.actions.find(
			(action: { id: string }) => action.id === "run_poem_auto_review",
		);
		expect(completePoemAction).toMatchObject({
			supportsScheduling: false,
			supportsNextTurnModelOverride: false,
			preview: expect.objectContaining({ kind: "terminal" }),
		});
		expect(requestRevisionAction).toMatchObject({
			supportsScheduling: true,
			supportsNextTurnModelOverride: true,
			preview: expect.objectContaining({ turnId: "draft_poem", turnKind: "llm" }),
		});
		expect(autoReviewAction).toMatchObject({
			supportsScheduling: true,
			supportsNextTurnModelOverride: true,
			preview: expect.objectContaining({ turnId: "review_poem_draft", turnKind: "llm" }),
		});

		const firstTurnRecords = harness.process(launched.id).snapshot().turns;
		expect(firstTurnRecords).toHaveLength(1);
		expect(firstTurnRecords[0]).toMatchObject({
			turnId: "draft_poem",
			status: "succeeded",
			pathType: "primary",
		});
		expect(firstTurnRecords[0]?.turnResultMarkdown).toEqual(expect.any(String));
		expect(firstTurnRecords[0]?.turnResultMarkdown?.trim().length).toBeGreaterThan(0);

		const runReviewResponse = await http(
			harness,
			`/api/processes/${launched.id}/actions/run_poem_auto_review`,
			{ method: "POST" },
		);
		expect(runReviewResponse.status).toBe(200);

		const afterAutoAcceptedReview = await waitForValue(
			() => ({
				process: harness.process(launched.id).snapshot().process,
				draftCount: harness
					.process(launched.id)
					.snapshot()
					.turns.filter((turnRecord) => turnRecord.turnId === "draft_poem").length,
				inputs: harness.process(launched.id).snapshot().inputs,
			}),
			(value) => {
				if (
					!value.process ||
					value.process.lifecycleStatus !== "waiting" ||
					value.draftCount !== 1
				) {
					return false;
				}
				const state = JSON.parse(value.process.stateJson ?? "null");
				return (
					value.process.selectedTurnId === "poem_review" &&
					state?.latestReviewOutcome === "no_issues"
				);
			},
		);
		expect(afterAutoAcceptedReview.process).toMatchObject({
			lifecycleStatus: "waiting",
		});
		expect(JSON.parse(afterAutoAcceptedReview.process?.stateJson ?? "null")).toMatchObject({
			latestReviewOutcome: "no_issues",
			latestReviewMarkdown: null,
			latestReviewSummary: expect.any(String),
		});
		expect(afterAutoAcceptedReview.inputs).toHaveLength(0);
		const llmReviewTurnRecordIds = new Set(
			harness
				.process(launched.id)
				.snapshot()
				.turns.filter((tr) => tr.turnId === "review_poem_draft")
				.map((tr) => tr.id),
		);
		const llmReviewToolCalls = harness
			.process(launched.id)
			.snapshot()
			.events.filter(
				(event) =>
					llmReviewTurnRecordIds.has(
						(event.data as { turnRecordId?: string }).turnRecordId ?? "",
					) && event.eventType === "pi.tool.call",
			)
			.map((event) => String((event.data as { name?: string }).name));
		expect(llmReviewToolCalls).toEqual(["no_issues"]);

		const reviewActionsResponse = await http(harness, `/api/processes/${launched.id}/actions`);
		const reviewActionsBody = await reviewActionsResponse.json();
		expect(reviewActionsResponse.status).toBe(200);
		expect(reviewActionsBody.actions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "complete_poem", label: "Complete poem" }),
				expect.objectContaining({ id: "request_poem_revision", label: "Request revision" }),
				expect.objectContaining({ id: "run_poem_auto_review", label: "Run automated review" }),
			]),
		);
		expect(
			reviewActionsBody.actions.filter((action: { id: string }) =>
				["accept_poem_review", "request_poem_review_changes"].includes(action.id),
			),
		).toEqual([]);

		const reviewTurnRecords = harness.process(launched.id).snapshot().turns;
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
		expect(
			reviewTurnRecords.some((turnRecord) => turnRecord.turnId === "poem_review_feedback"),
		).toBe(false);

		const completeResponse = await http(
			harness,
			`/api/processes/${launched.id}/actions/complete_poem`,
			{ method: "POST" },
		);
		expect(completeResponse.status).toBe(200);

		const completedProcess = await waitForValue(
			() => harness.process(launched.id).snapshot().process,
			(value) => value?.lifecycleStatus === "completed",
		);
		expect(completedProcess).toMatchObject({
			lifecycleStatus: "completed",
		});
	});

	it("schedules poem review-loop actions while rejecting terminal poem completion scheduling", async () => {
		const launched = await launchProcess(
			harness,
			"poem_creator_process.poem_creator_ui",
			{ prompt: "Write a short poem about sunrise over the city skyline." },
			"local_qwen",
		);

		await waitForValue(
			() => harness.process(launched.id).snapshot().process,
			(value) => value?.selectedTurnId === "poem_review" && value?.lifecycleStatus === "waiting",
		);

		const runReviewAt = new Date(Date.now() + 60_000).toISOString();
		const reviewScheduleResponse = await http(
			harness,
			`/api/processes/${launched.id}/actions/run_poem_auto_review`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					nextTurnModelProfileId: "claude_fast",
					schedule: {
						mode: "once",
						runAt: runReviewAt,
					},
				}),
			},
		);
		const reviewScheduleBody = await reviewScheduleResponse.json();

		expect(reviewScheduleResponse.status).toBe(201);
		expect(reviewScheduleBody.scheduledAction).toMatchObject({
			actionId: "run_poem_auto_review",
			nextTurnModelProfileId: "claude_fast",
			action: {
				supportsScheduling: true,
				supportsNextTurnModelOverride: true,
				preview: expect.objectContaining({
					turnId: "review_poem_draft",
					turnKind: "llm",
				}),
			},
		});

		const scheduledAction = reviewScheduleBody.scheduledAction;
		await http(harness, `/api/future-executions/${scheduledAction.id}`, { method: "DELETE" });

		const scheduleResponse = await http(
			harness,
			`/api/processes/${launched.id}/actions/complete_poem`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					schedule: {
						mode: "once",
						runAt: new Date(Date.now() + 120_000).toISOString(),
					},
				}),
			},
		);
		const scheduleBody = await scheduleResponse.json();

		expect(scheduleResponse.status).toBe(400);
		expect(scheduleBody.code).toBe("action_not_schedulable");
	});

	it("sends accepted leave_feedback review back to the primary branch", async () => {
		let issuesHarness: Awaited<ReturnType<typeof createShowcaseHarness>> | null = null;
		try {
			issuesHarness = await createLeaveFeedbackReviewHarness();

			const launched = await launchProcess(
				issuesHarness,
				"poem_creator_process.poem_creator_ui",
				{ prompt: "Write a short poem about cloud software under an evening sky." },
				"claude_fast",
			);

			await waitForValue(
				() => issuesHarness?.process(launched.id).snapshot().process,
				(value) => {
					if (!value || value.lifecycleStatus !== "waiting") {
						return false;
					}
					return value.selectedTurnId === "poem_review";
				},
			);

			const runReviewResponse = await http(
				issuesHarness,
				`/api/processes/${launched.id}/actions/run_poem_auto_review`,
				{ method: "POST" },
			);
			expect(runReviewResponse.status).toBe(200);

			const humanReviewOfReview = await waitForValue(
				() => issuesHarness?.process(launched.id).snapshot().process,
				(value) => {
					if (!value || value.lifecycleStatus !== "waiting") {
						return false;
					}
					return value.selectedTurnId === "poem_review_feedback";
				},
			);
			expect(JSON.parse(humanReviewOfReview?.stateJson ?? "null")).toMatchObject({
				latestReviewOutcome: "leave_feedback",
				latestReviewMarkdown: expect.any(String),
			});
			const llmReviewTurnRecordIds = new Set(
				issuesHarness
					.process(launched.id)
					.snapshot()
					.turns.filter((tr) => tr.turnId === "review_poem_draft")
					.map((tr) => tr.id),
			);
			const llmReviewToolCalls = issuesHarness
				.process(launched.id)
				.snapshot()
				.events.filter(
					(event) =>
						llmReviewTurnRecordIds.has(
							(event.data as { turnRecordId?: string }).turnRecordId ?? "",
						) && event.eventType === "pi.tool.call",
				)
				.map((event) => String((event.data as { name?: string }).name));
			expect(llmReviewToolCalls).toEqual(["leave_feedback"]);

			const processDetailResponse = await http(issuesHarness, `/api/processes/${launched.id}`);
			const processDetailBody = await processDetailResponse.json();
			expect(processDetailResponse.status).toBe(200);
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

			const reviewActionsResponse = await http(
				issuesHarness,
				`/api/processes/${launched.id}/actions`,
			);
			const reviewActionsBody = await reviewActionsResponse.json();
			expect(reviewActionsResponse.status).toBe(200);
			expect(reviewActionsBody.actions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "accept_poem_review", label: "Accept review" }),
					expect.objectContaining({
						id: "request_poem_review_changes",
						label: "Request review changes",
						supportsScheduling: true,
						supportsNextTurnModelOverride: true,
						preview: expect.objectContaining({
							turnId: "review_poem_draft",
							turnKind: "llm",
						}),
					}),
					expect.objectContaining({
						id: "dismiss_poem_review",
						label: "Dismiss review",
						supportsScheduling: false,
						supportsNextTurnModelOverride: false,
						preview: expect.objectContaining({
							turnId: "poem_review",
							turnKind: "human",
						}),
					}),
				]),
			);

			const reviewTurnRecords = issuesHarness.process(launched.id).snapshot().turns;
			expect(reviewTurnRecords).toHaveLength(3);

			const acceptReviewResponse = await http(
				issuesHarness,
				`/api/processes/${launched.id}/actions/accept_poem_review`,
				{ method: "POST" },
			);
			expect(acceptReviewResponse.status).toBe(200);

			const afterAcceptedReview = await waitForValue(
				() => ({
					process: issuesHarness?.process(launched.id).snapshot().process,
					draftCount: issuesHarness
						?.process(launched.id)
						.snapshot()
						.turns.filter((turnRecord) => turnRecord.turnId === "draft_poem").length,
					inputs: issuesHarness?.process(launched.id).snapshot().inputs ?? [],
				}),
				(value) => {
					if (
						!value.process ||
						value.process.lifecycleStatus !== "waiting" ||
						value.draftCount !== 2
					) {
						return false;
					}
					return value.process?.selectedTurnId === "poem_review";
				},
			);
			expect(afterAcceptedReview.process).toMatchObject({
				lifecycleStatus: "waiting",
			});
			expect(afterAcceptedReview.inputs).toEqual([]);
			const afterAcceptTurnRecords = issuesHarness.process(launched.id).snapshot().turns;
			const acceptedReviewDrafts = afterAcceptTurnRecords.filter(
				(turnRecord) => turnRecord.turnId === "draft_poem",
			);
			expect(acceptedReviewDrafts).toHaveLength(2);
			expect(acceptedReviewDrafts[1]).toMatchObject({
				pathType: "primary",
				forkPiEntryId: acceptedReviewDrafts[0]?.resultPiEntryId,
			});
			expect(afterAcceptTurnRecords).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						turnId: "poem_review_feedback",
						turnType: "human",
						status: "succeeded",
					}),
				]),
			);
		} finally {
			if (issuesHarness) {
				await issuesHarness.close();
			}
		}
	});

	it("supports a human revision loop for poem creator before returning to review", async () => {
		const launched = await launchProcess(
			harness,
			"poem_creator_process.poem_creator_ui",
			{ prompt: "Write a short poem about crafting cloud software at dusk." },
			"local_qwen",
		);

		await waitForValue(
			() => harness.process(launched.id).snapshot().process,
			(value) => value?.lifecycleStatus === "waiting",
		);

		const revisionResponse = await http(
			harness,
			`/api/processes/${launched.id}/actions/request_poem_revision`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					input: {
						message: "Make it calmer, more twilight-colored, and a little more precise.",
					},
				}),
			},
		);
		expect(revisionResponse.status).toBe(200);

		const rerun = await waitForValue(
			() => ({
				process: harness.process(launched.id).snapshot().process,
				draftCount: harness
					.process(launched.id)
					.snapshot()
					.turns.filter((turnRecord) => turnRecord.turnId === "draft_poem").length,
			}),
			(value) => {
				if (
					!value.process ||
					value.process.lifecycleStatus !== "waiting" ||
					value.draftCount !== 2
				) {
					return false;
				}
				return value.process?.selectedTurnId === "poem_review";
			},
		);
		expect(rerun.process).toMatchObject({
			lifecycleStatus: "waiting",
			defaultModelProfileId: "local_qwen",
		});

		const turnRecords = harness.process(launched.id).snapshot().turns;
		const draftTurnRecords = turnRecords.filter((turnRecord) => turnRecord.turnId === "draft_poem");
		expect(draftTurnRecords).toHaveLength(2);
		expect(draftTurnRecords[1]).toMatchObject({
			pathType: "primary",
			forkPiEntryId: draftTurnRecords[0]?.resultPiEntryId,
		});
		expect(turnRecords).toEqual(
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
		let issuesHarness: Awaited<ReturnType<typeof createShowcaseHarness>> | null = null;
		try {
			issuesHarness = await createLeaveFeedbackReviewHarness();

			const launched = await launchProcess(
				issuesHarness,
				"poem_creator_process.poem_creator_ui",
				{ prompt: "Write a short poem about rain over Berlin rooftops." },
				"claude_fast",
			);

			await waitForValue(
				() => issuesHarness?.process(launched.id).snapshot().process,
				(value) => {
					if (!value || value.lifecycleStatus !== "waiting") {
						return false;
					}
					return value.selectedTurnId === "poem_review";
				},
			);

			const runReviewResponse = await http(
				issuesHarness,
				`/api/processes/${launched.id}/actions/run_poem_auto_review`,
				{ method: "POST" },
			);
			expect(runReviewResponse.status).toBe(200);

			await waitForValue(
				() => issuesHarness?.process(launched.id).snapshot().process,
				(value) => {
					if (!value || value.lifecycleStatus !== "waiting") {
						return false;
					}
					return value.selectedTurnId === "poem_review_feedback";
				},
			);

			const recordsAfterFirstReview = issuesHarness.process(launched.id).snapshot().turns;
			const firstDraft = recordsAfterFirstReview.find(
				(turnRecord) => turnRecord.turnId === "draft_poem",
			);
			const firstReview = recordsAfterFirstReview
				.filter((turnRecord) => turnRecord.turnId === "review_poem_draft")
				.at(-1);
			expect(firstReview).toMatchObject({
				pathType: "root_branch",
				forkPiEntryId: firstDraft?.resultPiEntryId,
			});

			const requestChangesResponse = await http(
				issuesHarness,
				`/api/processes/${launched.id}/actions/request_poem_review_changes`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						input: {
							message:
								"Keep the same review branch, but make the review sharper and more concrete.",
						},
					}),
				},
			);
			expect(requestChangesResponse.status).toBe(200);

			const afterRerun = await waitForValue(
				() => ({
					process: issuesHarness?.process(launched.id).snapshot().process,
					reviewTurns: issuesHarness
						?.process(launched.id)
						.snapshot()
						.turns.filter((turnRecord) => turnRecord.turnId === "review_poem_draft"),
					draftTurns: issuesHarness
						?.process(launched.id)
						.snapshot()
						.turns.filter((turnRecord) => turnRecord.turnId === "draft_poem"),
				}),
				(value) => {
					if (!value.process || value.reviewTurns.length !== 2 || value.draftTurns.length !== 1) {
						return false;
					}
					return (
						value.process.lifecycleStatus === "waiting" &&
						value.process?.selectedTurnId === "poem_review_feedback"
					);
				},
			);

			const secondReview = afterRerun.reviewTurns.at(-1);
			expect(secondReview).toMatchObject({
				turnId: "review_poem_draft",
				status: "succeeded",
				pathType: "root_branch",
				forkPiEntryId: firstReview?.resultPiEntryId,
			});
		} finally {
			if (issuesHarness) {
				await issuesHarness.close();
			}
		}
	});
});

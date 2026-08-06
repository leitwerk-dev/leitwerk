import { createReviewSubject } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import {
	type AutomaticTurnDefinition,
	assertValidLlmTurnDefinition,
	automaticTurn,
	createRootBranchReviewTurn,
	externalTurn,
	type HumanTurnDefinition,
	humanTurn,
	isAutomaticTurnDefinition,
	isExternalTurnDefinition,
	isHumanTurnDefinition,
	isLlmTurnDefinition,
	type LlmTurnDefinition,
	llmTurn,
	resolveLlmTurnRestorePrimaryLeafAfterTurn,
	resolveLlmTurnStartSelection,
	validateAutomaticTurnDefinition,
	validateExternalTurnDefinition,
	validateHumanTurnDefinition,
	validateLlmTurnDefinition,
	validateTurnDefinition,
} from "./index.js";

function makeLlmTurn(
	overrides: Partial<LlmTurnDefinition<"done">> = {},
): LlmTurnDefinition<"done"> {
	return llmTurn({
		availableTools: [],
		description: "Implement changes",
		completionMode: "turn_end",
		branchType: "primary",
		context: "full",
		prompt: async () => "implement",
		outcomes: {
			done: {
				description: "Done",
				parameters: {},
			},
		},
		...overrides,
	});
}

function makeAutomaticTurn(
	overrides: Partial<AutomaticTurnDefinition<"done">> = {},
): AutomaticTurnDefinition<"done"> {
	return automaticTurn({
		description: "Commit and merge",
		outcomes: {
			done: {
				description: "Done",
				parameters: {},
			},
		},
		run: async () => ({ outcome: "done", params: {} }),
		...overrides,
	});
}

function makeHumanTurn(overrides: Partial<HumanTurnDefinition> = {}): HumanTurnDefinition {
	return humanTurn({
		description: "Review the plan",
		reviewSubject: createReviewSubject("plan"),
		actions: {
			approve_plan: { acceptanceState: "accepted" },
			request_revision: { acceptanceState: "requires_changes" },
		},
		notesFields: [{ id: "message", label: "Review notes" }],
		...overrides,
	});
}

describe("turn semantics", () => {
	it("resolves defaults for primary-path LLM turns", () => {
		const turn = makeLlmTurn({ branchType: "primary", startFrom: undefined });

		expect(resolveLlmTurnStartSelection(turn)).toEqual({ kind: "current_leaf" });
		expect(resolveLlmTurnRestorePrimaryLeafAfterTurn(turn)).toBe(false);
		expect(validateLlmTurnDefinition("implement", turn)).toEqual([]);
		expect(isLlmTurnDefinition(turn)).toBe(true);
		expect(validateTurnDefinition("implement", turn)).toEqual([]);
	});

	it("accepts turn-end completion without outcome tools when turnEnd is declared", () => {
		const turn = makeLlmTurn({
			outcomes: {},
			turnEnd: { outcome: "done", params: { summary: "completed" } },
		});

		expect(validateLlmTurnDefinition("implement", turn)).toEqual([]);
	});

	it("rejects turns that mix outcomes with turnEnd", () => {
		const turn = makeLlmTurn({
			turnEnd: { outcome: "done" },
		});

		expect(validateLlmTurnDefinition("implement", turn)).toEqual([
			"LLM turn 'implement' cannot declare both outcomes and turnEnd",
		]);
	});

	it("validates array outcome parameters", () => {
		expect(
			validateLlmTurnDefinition(
				"implement",
				makeLlmTurn({
					outcomes: {
						done: {
							description: "Done",
							parameters: {
								acceptanceCriteria: {
									type: "array",
									description: "Acceptance criteria",
									items: { type: "string" },
									required: true,
								},
							},
						},
					},
				}),
			),
		).toEqual([]);

		expect(
			validateLlmTurnDefinition(
				"implement",
				makeLlmTurn({
					outcomes: {
						done: {
							description: "Done",
							parameters: {
								acceptanceCriteria: {
									type: "array",
									description: "Acceptance criteria",
								},
							},
						},
					},
				}),
			),
		).toEqual([expect.stringContaining("acceptanceCriteria")]);
	});

	it("rejects invalid outcome parameter schemas", () => {
		const llmErrors = validateLlmTurnDefinition(
			"implement",
			makeLlmTurn({
				outcomes: {
					done: {
						description: "Done",
						parameters: {
							summary: {
								type: "string",
								description: "Summary",
								items: { type: "string" },
							},
							changes: {
								type: "array",
								description: "Nested changes",
								items: { type: "array" as never },
							},
						},
					},
				},
			}),
		);
		expect(llmErrors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("summary"),
				expect.stringContaining("changes"),
			]),
		);

		const automaticErrors = validateAutomaticTurnDefinition(
			"commit_and_merge",
			makeAutomaticTurn({
				outcomes: {
					done: {
						description: "Done",
						parameters: {
							summary: {
								type: "string",
								description: "Summary",
								items: { type: "string" },
							},
						},
					},
				},
			}),
		);
		expect(automaticErrors).toEqual([expect.stringContaining("summary")]);
	});

	it("creates root-branch review turns as a reusable pattern", () => {
		const reviewTurn = createRootBranchReviewTurn({
			description: "Review the implementation",
			availableTools: [],
			context: "fresh",
			prompt: async () => "review",
			outcomes: {
				reviewed: {
					description: "Reviewed",
					parameters: {},
				},
			},
		});

		expect(reviewTurn).toMatchObject({
			kind: "llm",
			completionMode: "turn_end",
			branchType: "root_branch",
			restorePrimaryLeafAfterTurn: true,
		});
		expect(resolveLlmTurnStartSelection(reviewTurn)).toEqual({ kind: "session_root" });
		expect(validateLlmTurnDefinition("run_llm_review", reviewTurn)).toEqual([]);
	});

	it("rejects invalid Pi tool selections and start combinations", () => {
		expect(
			validateLlmTurnDefinition(
				"implement",
				makeLlmTurn({
					availableTools: ["read", "wat"] as never,
				}),
			),
		).toEqual(
			expect.arrayContaining([
				expect.stringContaining("availableTools references unknown Pi tool 'wat'"),
			]),
		);
		expect(
			validateLlmTurnDefinition(
				"implement",
				makeLlmTurn({
					availableTools: ["read", "read"],
				}),
			),
		).toEqual(
			expect.arrayContaining([
				expect.stringContaining("availableTools must not contain duplicate Pi tool 'read'"),
			]),
		);
		expect(
			validateLlmTurnDefinition(
				"implement",
				makeLlmTurn({
					availableTools: [" read "] as never,
				}),
			),
		).toEqual(expect.arrayContaining([expect.stringContaining("without surrounding whitespace")]));
		expect(
			validateLlmTurnDefinition("implement", {
				...makeLlmTurn(),
				availableTools: undefined as never,
			}),
		).toEqual(
			expect.arrayContaining([expect.stringContaining("must declare availableTools as an array")]),
		);
		expect(
			validateLlmTurnDefinition(
				"implement",
				makeLlmTurn({
					branchType: "root_branch",
					startFrom: { kind: "current_leaf" },
				}),
			),
		).toEqual(
			expect.arrayContaining([
				expect.stringContaining("uses branchType 'root_branch' but starts from the current leaf"),
			]),
		);
	});

	it("validates automatic turns with declared deterministic outcomes", () => {
		const turn = makeAutomaticTurn();

		expect(isAutomaticTurnDefinition(turn)).toBe(true);
		expect(validateAutomaticTurnDefinition("commit_and_merge", turn)).toEqual([]);
		expect(validateTurnDefinition("commit_and_merge", turn)).toEqual([]);
	});

	it("rejects automatic turns without a declared completion path", () => {
		expect(
			validateAutomaticTurnDefinition("commit_and_merge", makeAutomaticTurn({ outcomes: {} })),
		).toEqual([
			"Automatic turn 'commit_and_merge' must declare at least one outcome tool or a turnEnd result",
		]);
	});

	it("validates human and external turns", () => {
		const human = makeHumanTurn({ commentary: "Choose whether to approve or request revision." });
		expect(isHumanTurnDefinition(human)).toBe(true);
		expect(validateHumanTurnDefinition("plan_review", human)).toEqual([]);
		expect(validateTurnDefinition("plan_review", human)).toEqual([]);

		const external = externalTurn({
			description: "Wait for completion",
			transitions: [
				{
					source: {
						kind: "example.file.presence",
						label: "Prompt-complete file",
						description: "Write to the configured prompt-complete trigger file.",
						config: { path: "/tmp/complete-prompt" },
					},
					complete: true,
				},
			],
		});
		expect(isExternalTurnDefinition(external)).toBe(true);
		expect(validateExternalTurnDefinition("await_external_completion", external)).toEqual([]);
		expect(validateTurnDefinition("await_external_completion", external)).toEqual([]);
	});

	it("rejects invalid human turn previews, triggers, and notes", () => {
		expect(
			validateHumanTurnDefinition(
				"plan_review",
				makeHumanTurn({
					actions: {
						approve_plan: {
							acceptanceState: "accepted",
							preview: { kind: "trigger", trigger: "   " },
						},
					},
				}),
			),
		).toEqual([expect.stringContaining("preview must declare a non-empty trigger preview")]);

		expect(
			validateHumanTurnDefinition(
				"plan_review",
				makeHumanTurn({
					actions: {
						approve_plan: {
							acceptanceState: "accepted",
							externalTriggers: [
								{
									id: "review_file",
									label: "Review file",
									description: "desc",
								},
							],
						},
						request_revision: {
							acceptanceState: "requires_changes",
							externalTriggers: [
								{
									id: "review_file",
									label: "Review file again",
									description: "desc",
								},
							],
						},
					},
				}),
			),
		).toEqual(
			expect.arrayContaining(["Human turn 'plan_review' contains duplicate external trigger ids"]),
		);

		expect(
			validateHumanTurnDefinition(
				"plan_review",
				makeHumanTurn({
					notesFields: [
						{ id: "message", label: "First" },
						{ id: "message", label: "Second" },
					],
				}),
			),
		).toContain("Human turn 'plan_review' contains duplicate notes field id 'message'");
	});

	it("rejects invalid external turn definitions", () => {
		const turn = externalTurn({
			description: "Wait",
			transitions: [
				{
					source: { kind: "", config: {} },
				},
			],
		});
		expect(validateExternalTurnDefinition("await_external_completion", turn)).toEqual([
			"External turn 'await_external_completion' source transition 0 must declare a non-empty kind",
			"External turn 'await_external_completion' source transition 0 must declare exactly one target",
		]);
	});

	it("assert helpers throw when validation fails", () => {
		expect(() =>
			assertValidLlmTurnDefinition("implement", makeLlmTurn({ turnEnd: { outcome: "done" } })),
		).toThrow(/cannot declare both outcomes and turnEnd/);
	});
});

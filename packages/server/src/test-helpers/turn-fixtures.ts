import { type LlmTurnDefinition, llmTurn } from "@leitwerk-dev/process-sdk";

type TestLlmTurnOverrides<TOutcome extends string, TParams = unknown, TState = unknown> = Omit<
	Partial<LlmTurnDefinition<TOutcome, TParams, TState>>,
	"kind" | "outcomes"
>;

export function createTestLlmTurn<TOutcome extends string, TParams = unknown, TState = unknown>(
	id: string,
	outcomes: NonNullable<LlmTurnDefinition<TOutcome, TParams, TState>["outcomes"]>,
	overrides: TestLlmTurnOverrides<TOutcome, TParams, TState> = {},
): LlmTurnDefinition<TOutcome, TParams, TState> {
	const prompt = overrides.prompt ?? (async () => id);
	return llmTurn<TParams, TState, TOutcome>({
		description: id,
		availableTools: [],
		completionMode: "turn_end",
		branchType: "primary",
		context: "full",
		...overrides,
		prompt,
		outcomes,
	});
}

export function createRequiredStringParameter(
	description: string,
	requiredErrorCode = "summary_required",
) {
	return {
		type: "string" as const,
		description,
		required: true,
		requiredErrorCode,
	};
}

export function createSummaryParameter() {
	return createRequiredStringParameter("summary", "summary_required");
}

export function createAcceptanceCriteriaParameter(description = "criteria") {
	return {
		type: "array" as const,
		description,
		items: { type: "string" as const },
		required: true,
		requiredErrorCode: "acceptance_criteria_required",
		minItems: 1,
		minItemsErrorCode: "acceptance_criteria_required",
	};
}

export function createPlanMarkdownParameter(description = "plan markdown") {
	return createRequiredStringParameter(description, "plan_markdown_required");
}

export function createChangedProjectsParameter(description = "changed projects") {
	return {
		type: "array" as const,
		description,
		items: { type: "string" as const },
	};
}

export function createReviewMarkdownParameter(description = "review") {
	return createRequiredStringParameter(description, "review_markdown_required");
}

export function createIssueCountParameter(description = "count") {
	return {
		type: "number" as const,
		description,
		minimum: 0,
		minimumErrorCode: "invalid_issue_count",
		invalidErrorCode: "invalid_issue_count",
	};
}

export function createPlanSavedOutcomeTools<TParams = unknown, TState = unknown>(): NonNullable<
	LlmTurnDefinition<"plan_saved", TParams, TState>["outcomes"]
> {
	return {
		plan_saved: {
			description: "plan saved",
			parameters: {
				summary: createSummaryParameter(),
				acceptanceCriteria: createAcceptanceCriteriaParameter(),
				planMarkdown: createPlanMarkdownParameter(),
			},
		},
	};
}

export function createDoneOutcomeTools<TParams = unknown, TState = unknown>(
	options: { includeChangedProjects?: boolean } = {},
) {
	return {
		done: {
			description: "done",
			parameters: {
				summary: createSummaryParameter(),
				...(options.includeChangedProjects
					? {
							changedProjects: createChangedProjectsParameter(),
						}
					: {}),
			},
		},
	} satisfies NonNullable<LlmTurnDefinition<"done", TParams, TState>["outcomes"]>;
}

export function createCommentsAddressedOutcomeTools<TParams = unknown, TState = unknown>() {
	return {
		comments_addressed: {
			description: "comments addressed",
			parameters: {
				summary: createSummaryParameter(),
			},
		},
	} satisfies NonNullable<LlmTurnDefinition<"comments_addressed", TParams, TState>["outcomes"]>;
}

export function createCommittedOutcomeTools<TParams = unknown, TState = unknown>() {
	return {
		committed: {
			description: "committed",
			parameters: {
				summary: createSummaryParameter(),
			},
		},
	} satisfies NonNullable<LlmTurnDefinition<"committed", TParams, TState>["outcomes"]>;
}

export function createBuildVerificationOutcomeTools<TParams = unknown, TState = unknown>() {
	return {
		build_passing: { description: "build passing", parameters: {} },
		build_failing: {
			description: "build failing",
			parameters: {
				summary: createSummaryParameter(),
			},
		},
	} satisfies NonNullable<
		LlmTurnDefinition<"build_passing" | "build_failing", TParams, TState>["outcomes"]
	>;
}

export function createBuildFixOutcomeTools<TParams = unknown, TState = unknown>() {
	return {
		build_fixed: {
			description: "build fixed",
			parameters: {
				summary: createSummaryParameter(),
			},
		},
		build_unfixable: {
			description: "build unfixable",
			parameters: {
				summary: createSummaryParameter(),
			},
		},
	} satisfies NonNullable<
		LlmTurnDefinition<"build_fixed" | "build_unfixable", TParams, TState>["outcomes"]
	>;
}

export function createReviewOutcomeTools<TParams = unknown, TState = unknown>() {
	return {
		issues_found: {
			description: "issues found",
			parameters: {
				reviewMarkdown: createReviewMarkdownParameter(),
				issueCount: createIssueCountParameter(),
			},
		},
		no_issues: {
			description: "no issues",
			parameters: {},
		},
	} satisfies NonNullable<
		LlmTurnDefinition<"no_issues" | "issues_found", TParams, TState>["outcomes"]
	>;
}

import { createReviewSubject, normalizeOptionalMarkdown } from "@leitwerk-dev/domain";
import {
	acceptedReviewHandoffAction,
	type Codec,
	createEmptyStructuralProcessState,
	type FormDefinition,
	flow,
	type HumanTurnDefinition,
	humanTurn,
	type ProcessLauncherDefinition,
	type RepositoryCredentialProject,
	type RepositoryCredentialRequirement,
	revisionAction,
} from "@leitwerk-dev/process-sdk";
import {
	acceptReviewForm,
	codingActionIds,
	requestReviewChangesForm,
	requestRevisionForm,
} from "./actions.js";
import { runDeterministicFinalization } from "./finalization-git.js";
import {
	clearReviewRefs,
	createEmptyRepositoryChangeFinalizationState,
	type RepositoryChangeState,
	repositoryChangeStateCodec,
	resetRepositoryChangeFinalizationState,
} from "./repository-change-state.js";
import {
	buildGenerateCommitMessagePrompt,
	normalizeGeneratedCommitMessage,
} from "./turns/generate-commit-message.js";
import { buildGeneratePlanPrompt } from "./turns/generate-plan.js";
import { buildImplementPrompt } from "./turns/implement.js";
import { buildResolveMergeConflictPrompt } from "./turns/resolve-merge-conflict.js";
import { buildReviewImplementationPrompt } from "./turns/review-implementation.js";
import { buildReviewPlanPrompt } from "./turns/review-plan.js";
import { buildSimplifyImplementationPrompt } from "./turns/simplify-implementation.js";

export type RepositoryChangeParams = {
	launchKind: "requested_change" | "imported_plan";
	importedPlanMarkdown?: string;
};

export interface RepositoryChangeProcessConfig<TParams extends RepositoryChangeParams> {
	processId: string;
	displayName: string;
	paramsCodec: Codec<TParams>;
	launcher: ProcessLauncherDefinition<TParams>;
	finalizeLabel: string;
	finalizeForm: FormDefinition;
	finalizationDescription: string;
	repositoryCredentials?(input: {
		params: TParams;
		projects: readonly RepositoryCredentialProject[];
	}): readonly RepositoryCredentialRequirement[];
}

export function createRepositoryChangeProcess<TParams extends RepositoryChangeParams>(
	config: RepositoryChangeProcessConfig<TParams>,
) {
	const planReviewSubject = createReviewSubject("plan");
	const implementationReviewSubject = createReviewSubject("implementation");

	const turnIds = {
		importPlan: "import_plan",
		generatePlan: "generate_plan",
		planDecision: "plan_decision",
		reviewPlan: "review_plan",
		planReviewFeedback: "plan_review_feedback",
		implement: "implement",
		implementationDecision: "implementation_decision",
		reviewImplementation: "review_implementation",
		implementationReviewFeedback: "implementation_review_feedback",
		simplifyImplementation: "simplify_implementation",
		simplificationDecision: "simplification_decision",
		generateCommitMessage: "generate_commit_message",
		commitAndMerge: "commit_and_merge",
		resolveMergeConflict: "resolve_merge_conflict",
	} as const;

	const products = {
		plan: "plan",
		review: "review",
		simplificationPlan: "simplification-plan",
		implementationSummary: "implementation-summary",
		mergeResolutionSummary: "merge-resolution-summary",
		commitMessage: "commit-message",
	} as const;

	const implementationTurnAvailableTools = ["read", "bash", "edit", "write"] as const;

	function normalizeMessage(value: unknown): string {
		return typeof value === "string" ? value.trim() : "";
	}

	function resetFinalizationAfterMessage(
		state: RepositoryChangeState,
		overrides: Partial<RepositoryChangeState["finalization"]> = {},
	) {
		return resetRepositoryChangeFinalizationState({
			generatedCommitMessage: state.finalization.generatedCommitMessage,
			...overrides,
		});
	}

	function hasResolvedTurnRecordRef(
		ref: RepositoryChangeState["semanticEntryRefs"][keyof RepositoryChangeState["semanticEntryRefs"]],
	): ref is { entryId: string; turnRecordId: string } {
		return typeof ref?.turnRecordId === "string" && ref.turnRecordId.trim() !== "";
	}

	function requireResolvedPlanRef(
		plan: RepositoryChangeState["semanticEntryRefs"][keyof RepositoryChangeState["semanticEntryRefs"]],
		usage: "simplification review" | "implementation review",
	): asserts plan is { entryId: string; turnRecordId: string } {
		if (!hasResolvedTurnRecordRef(plan)) {
			throw new Error(`No plan is available for ${usage}`);
		}
	}

	function buildImplementationReviewTurnState(ctx: {
		state: RepositoryChangeState;
	}): RepositoryChangeState {
		return patchRepositoryChangeState(ctx.state, {
			reviewSubject: implementationReviewSubject,
			clearReviewRefs: true,
			clearProductRefs: [products.simplificationPlan],
		});
	}

	function buildAcceptedReviewFollowUpMessage(input: {
		reviewSubject: { kind: "plan" | "implementation" };
		reviewMarkdown: string;
		adjustment?: string | null;
	}): string {
		const adjustment = normalizeMessage(input.adjustment);
		if (input.reviewSubject.kind === "plan") {
			return [
				"Revise the plan according to this review:",
				input.reviewMarkdown,
				adjustment
					? ["Also follow this adjustment where it conflicts with the review:", adjustment].join(
							"\n\n",
						)
					: null,
			]
				.filter((section): section is string => typeof section === "string" && section !== "")
				.join("\n\n");
		}
		return buildAcceptedImplementationFollowUpMessage({
			kind: "review",
			implementationMarkdown: input.reviewMarkdown,
			adjustment,
		});
	}

	function buildAcceptedImplementationFollowUpMessage(input: {
		kind: "review" | "simplification";
		implementationMarkdown: string;
		adjustment?: string | null;
	}): string {
		const adjustment = normalizeMessage(input.adjustment);
		const isSimplification = input.kind === "simplification";
		const subject = isSimplification ? "simplification plan" : "review";

		return [
			`Implement according to this ${subject}:`,
			input.implementationMarkdown,
			adjustment
				? [`Also follow this adjustment where it conflicts with the ${subject}:`, adjustment].join(
						"\n\n",
					)
				: null,
			[
				"This is now an implementation turn. Ignore earlier review-only or read-only instructions.",
				"You may change files in the repository workspace.",
				`Use the available tools (${implementationTurnAvailableTools.join(", ")}) to inspect, edit, build, and test the change.`,
				"When finished, return an implementation summary.",
			].join("\n"),
		]
			.filter((section): section is string => typeof section === "string" && section !== "")
			.join("\n\n");
	}

	function buildAcceptedSimplificationFollowUpMessage(input: {
		simplificationMarkdown: string;
		adjustment?: string | null;
	}): string {
		return buildAcceptedImplementationFollowUpMessage({
			kind: "simplification",
			implementationMarkdown: input.simplificationMarkdown,
			adjustment: input.adjustment,
		});
	}

	function patchRepositoryChangeState(
		state: RepositoryChangeState,
		input: {
			reviewSubject?: RepositoryChangeState["reviewSubject"];
			finalization?: RepositoryChangeState["finalization"];
			semanticEntryRefs?: RepositoryChangeState["semanticEntryRefs"];
			clearReviewRefs?: boolean;
			clearProductRefs?: readonly string[];
		},
	): RepositoryChangeState {
		const nextState: RepositoryChangeState = {
			...state,
			...("reviewSubject" in input ? { reviewSubject: input.reviewSubject ?? null } : {}),
			...("finalization" in input ? { finalization: input.finalization } : {}),
			...("semanticEntryRefs" in input ? { semanticEntryRefs: input.semanticEntryRefs } : {}),
		};
		const productRefsToClear = new Set(input.clearProductRefs ?? []);
		if (input.clearReviewRefs) {
			productRefsToClear.add(products.review);
		}
		if (!input.clearReviewRefs && productRefsToClear.size === 0) {
			return nextState;
		}
		const productRefs = { ...nextState.productRefs };
		for (const productName of productRefsToClear) {
			delete productRefs[productName];
		}
		return {
			...nextState,
			semanticEntryRefs: input.clearReviewRefs
				? clearReviewRefs(nextState.semanticEntryRefs)
				: nextState.semanticEntryRefs,
			productRefs,
		};
	}

	const planDecisionSpec = humanTurn<TParams, RepositoryChangeState>({
		description: "Review plan",
		reviewSubject: planReviewSubject,
		reviewSemanticRef: "plan",
		notesFields: [
			{
				id: "message",
				label: "Revision notes",
				placeholder: "Describe what the next plan revision should improve",
				required: true,
			},
		],
		commentary: "Approve this plan, request a revision, or run an automated review.",
		actions: {
			[codingActionIds.approvePlan]: {
				label: "Approve plan",
				description: "Accept the current plan and continue into implementation.",
				acceptanceState: "accepted",
				to: turnIds.implement,
				effect: ({ ctx }) => {
					const plan = ctx.state.semanticEntryRefs.plan;
					if (!hasResolvedTurnRecordRef(plan)) {
						throw new Error("No plan is available for approval");
					}
					return {
						state: patchRepositoryChangeState(ctx.state, {
							reviewSubject: null,
							clearReviewRefs: true,
							clearProductRefs: [products.simplificationPlan],
						}),
						emit: [
							{
								type: "plan_approved",
								data: {
									externalId: ctx.process.externalId,
									planRevision: ctx.process.planRevision,
								},
							},
						],
					};
				},
			},
			[codingActionIds.requestRevision]: revisionAction({
				label: "Request revision",
				description: "Send the plan back for another draft revision.",
				acceptanceState: "requires_changes",
				form: requestRevisionForm,
				schedulable: true,
				to: turnIds.generatePlan,
				queueTarget: { semanticRef: "currentPrimaryPathLeaf" },
				effect: ({ ctx, input }) => {
					const message = normalizeMessage(input.message);
					return {
						state: patchRepositoryChangeState(ctx.state, {
							reviewSubject: null,
							clearReviewRefs: true,
							clearProductRefs: [products.simplificationPlan],
						}),
						emit: [{ type: "plan_revision_requested", data: { message } }],
					};
				},
			}),
			[codingActionIds.runReview]: {
				label: "Run automated review",
				description: "Send the current plan to the LLM reviewer.",
				acceptanceState: "neutral",
				schedulable: true,
				to: turnIds.reviewPlan,
				effect: ({ ctx }) => {
					const plan = ctx.state.semanticEntryRefs.plan;
					if (!hasResolvedTurnRecordRef(plan)) {
						throw new Error("No plan is available for review");
					}
					return {
						state: patchRepositoryChangeState(ctx.state, {
							reviewSubject: planReviewSubject,
							clearReviewRefs: true,
							clearProductRefs: [products.simplificationPlan],
						}),
					};
				},
			},
		},
	});

	const planReviewFeedbackSpec = humanTurn<TParams, RepositoryChangeState>({
		description: "Review plan feedback",
		reviewSubject: planReviewSubject,
		reviewSemanticRef: "review",
		notesFields: [
			{
				id: "message",
				label: "Review notes",
				placeholder: "Describe how the next review pass should change",
				required: true,
			},
		],
		commentary:
			"Apply this feedback to the next plan revision, request a revised review, or dismiss it.",
		actions: {
			[codingActionIds.acceptReview]: acceptedReviewHandoffAction({
				label: "Accept review",
				description: "Apply the current review outcome and continue with the plan flow.",
				acceptanceState: "accepted",
				form: acceptReviewForm,
				to: turnIds.generatePlan,
				resolveBodyMarkdown: ({ ctx, input }) => {
					const reviewMarkdown = normalizeOptionalMarkdown(
						ctx.readSemanticTurnResultMarkdown("review"),
					);
					if (!reviewMarkdown) {
						throw new Error("No review output markdown is available to accept");
					}
					return buildAcceptedReviewFollowUpMessage({
						reviewSubject: planReviewSubject,
						reviewMarkdown,
						adjustment: normalizeMessage(input.message),
					});
				},
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
						reviewSubject: null,
					}),
				}),
			}),
			[codingActionIds.requestReviewChanges]: revisionAction({
				label: "Request review changes",
				description: "Ask the LLM reviewer to revise its plan review.",
				acceptanceState: "requires_changes",
				form: requestReviewChangesForm,
				to: turnIds.reviewPlan,
				queueTarget: { semanticRef: "review" },
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
						reviewSubject: planReviewSubject,
					}),
				}),
			}),
			[codingActionIds.dismissReview]: {
				label: "Dismiss review",
				description: "Return to the plan decision without applying the review.",
				acceptanceState: "neutral",
				to: turnIds.planDecision,
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
						reviewSubject: planReviewSubject,
					}),
				}),
			},
		},
	});

	const implementationDecisionSpec = humanTurn<TParams, RepositoryChangeState>({
		description: "Review implementation",
		reviewSubject: implementationReviewSubject,
		reviewSemanticRef: "currentPrimaryPathLeaf",
		notesFields: [
			{
				id: "message",
				label: "Revision notes",
				placeholder: "Describe what the next implementation turn should improve",
				required: true,
			},
		],
		commentary:
			"Merge this implementation, request another pass, simplify it, or run an automated review.",
		actions: {
			[codingActionIds.finalizeChange]: {
				label: config.finalizeLabel,
				acceptanceState: "accepted",
				form: config.finalizeForm,
				schedulable: true,
				to: turnIds.generateCommitMessage,
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
						reviewSubject: null,
						finalization: createEmptyRepositoryChangeFinalizationState(),
						clearReviewRefs: true,
						clearProductRefs: [products.simplificationPlan],
					}),
				}),
			},
			[codingActionIds.requestRevision]: revisionAction({
				label: "Request revision",
				acceptanceState: "requires_changes",
				form: requestRevisionForm,
				schedulable: true,
				to: turnIds.implement,
				queueTarget: { semanticRef: "currentPrimaryPathLeaf" },
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
						reviewSubject: null,
						clearReviewRefs: true,
						clearProductRefs: [products.simplificationPlan],
					}),
				}),
			}),
			[codingActionIds.simplify]: {
				label: "Simplify",
				description: "Ask for a focused simplification review before another implementation pass.",
				acceptanceState: "neutral",
				schedulable: true,
				to: turnIds.simplifyImplementation,
				effect: ({ ctx }) => {
					requireResolvedPlanRef(ctx.state.semanticEntryRefs.plan, "simplification review");
					return { state: buildImplementationReviewTurnState(ctx) };
				},
			},
			[codingActionIds.runReview]: {
				label: "Run automated review",
				acceptanceState: "neutral",
				schedulable: true,
				to: turnIds.reviewImplementation,
				effect: ({ ctx }) => {
					requireResolvedPlanRef(ctx.state.semanticEntryRefs.plan, "implementation review");
					return { state: buildImplementationReviewTurnState(ctx) };
				},
			},
		},
	});

	const implementationReviewFeedbackSpec = humanTurn<TParams, RepositoryChangeState>({
		description: "Review implementation feedback",
		reviewSubject: implementationReviewSubject,
		reviewSemanticRef: "review",
		notesFields: [
			{
				id: "message",
				label: "Review notes",
				placeholder: "Describe how the next implementation review pass should change",
				required: true,
			},
		],
		commentary:
			"Apply this feedback to the next implementation pass, request a revised review, or dismiss it.",
		actions: {
			[codingActionIds.acceptReview]: acceptedReviewHandoffAction({
				label: "Accept review",
				acceptanceState: "accepted",
				form: acceptReviewForm,
				schedulable: true,
				to: turnIds.implement,
				queueTarget: { semanticRef: "review" },
				resolveBodyMarkdown: ({ ctx, input }) => {
					const reviewMarkdown = normalizeOptionalMarkdown(
						ctx.readSemanticTurnResultMarkdown("review"),
					);
					if (!reviewMarkdown) {
						throw new Error("No review output markdown is available to accept");
					}
					return buildAcceptedReviewFollowUpMessage({
						reviewSubject: implementationReviewSubject,
						reviewMarkdown,
						adjustment: normalizeMessage(input.message),
					});
				},
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
						reviewSubject: null,
						clearProductRefs: [products.simplificationPlan],
					}),
				}),
			}),
			[codingActionIds.requestReviewChanges]: revisionAction({
				label: "Request review changes",
				acceptanceState: "requires_changes",
				form: requestReviewChangesForm,
				schedulable: true,
				to: turnIds.reviewImplementation,
				queueTarget: { semanticRef: "review" },
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
						reviewSubject: implementationReviewSubject,
					}),
				}),
			}),
			[codingActionIds.dismissReview]: {
				label: "Dismiss review",
				acceptanceState: "neutral",
				to: turnIds.implementationDecision,
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
						reviewSubject: implementationReviewSubject,
					}),
				}),
			},
		},
	});

	const simplificationDecisionSpec = humanTurn<TParams, RepositoryChangeState>({
		description: "Review simplification plan",
		reviewSubject: implementationReviewSubject,
		reviewProduct: products.simplificationPlan,
		notesFields: [
			{
				id: "message",
				label: "Simplification notes",
				placeholder: "Describe how the simplification plan should change",
				required: true,
			},
		],
		commentary: "Apply this simplification plan, request changes to it, or reject it.",
		actions: {
			[codingActionIds.acceptReview]: acceptedReviewHandoffAction({
				label: "Accept simplification plan",
				acceptanceState: "accepted",
				form: acceptReviewForm,
				schedulable: true,
				to: turnIds.implement,
				queueTarget: { productName: products.simplificationPlan },
				resolveBodyMarkdown: ({ ctx, input }) => {
					const simplificationMarkdown = normalizeOptionalMarkdown(
						ctx.readProductTurnResultMarkdown(products.simplificationPlan),
					);
					if (!simplificationMarkdown) {
						throw new Error("No simplification plan markdown is available to accept");
					}
					return buildAcceptedSimplificationFollowUpMessage({
						simplificationMarkdown,
						adjustment: normalizeMessage(input.message),
					});
				},
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
						reviewSubject: null,
						clearReviewRefs: true,
					}),
				}),
			}),
			[codingActionIds.requestReviewChanges]: revisionAction({
				label: "Request simplification changes",
				acceptanceState: "requires_changes",
				form: requestReviewChangesForm,
				to: turnIds.simplifyImplementation,
				queueTarget: { productName: products.simplificationPlan },
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
						reviewSubject: implementationReviewSubject,
					}),
				}),
			}),
			[codingActionIds.dismissReview]: {
				label: "Reject simplification plan",
				description:
					"Return to the implementation decision without applying the simplification plan.",
				acceptanceState: "neutral",
				to: turnIds.implementationDecision,
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
						reviewSubject: implementationReviewSubject,
						clearReviewRefs: true,
						clearProductRefs: [products.simplificationPlan],
					}),
				}),
			},
		},
	});

	const importPlanTurn = flow
		.serverAutomatic<TParams, RepositoryChangeState>(turnIds.importPlan)
		.description("Import handoff plan")
		.run((ctx) => {
			const planMarkdown =
				ctx.params.launchKind === "imported_plan"
					? normalizeOptionalMarkdown(ctx.params.importedPlanMarkdown)
					: null;
			if (!planMarkdown) {
				throw new Error("No importedPlanMarkdown is available to import");
			}
			return {
				outcome: "imported",
				params: { plan: planMarkdown },
				markdown: planMarkdown,
				state: patchRepositoryChangeState(ctx.state, {
					reviewSubject: null,
					clearReviewRefs: true,
					clearProductRefs: [products.simplificationPlan],
				}),
			};
		})
		.outcome("imported", (outcome) =>
			outcome
				.description("Imported a handoff plan and skipped replanning")
				.markdown("plan", { description: "Imported handoff plan", publish: true })
				.to(turnIds.implement)
				.effect(({ ctx }) => ({ processPatch: { planRevision: ctx.process.planRevision + 1 } })),
		);

	const generatePlanTurn = flow
		.llm<TParams, RepositoryChangeState>(turnIds.generatePlan)
		.description("Draft plan")
		.tools("read", "bash")
		.askQuestions()
		.freshPrimary()
		.buildPrompt(buildGeneratePlanPrompt)
		.outcomeTool("plan_saved", (tool) =>
			tool
				.description(
					"Save the finished plan for review. Its Markdown may include Mermaid diagrams or uploaded images.",
				)
				.requiredString("summary", "Short summary of the proposed plan")
				.requiredStringArray(
					"acceptanceCriteria",
					"Acceptance criteria for the requested repository change",
				)
				.to(turnIds.planDecision)
				.effect(({ ctx, event }) => {
					const planRevision = ctx.process.planRevision + 1;
					const summary = normalizeMessage(event.params.summary);
					const acceptanceCriteria = Array.isArray(event.params.acceptanceCriteria)
						? event.params.acceptanceCriteria.filter(
								(entry): entry is string => typeof entry === "string" && entry.trim() !== "",
							)
						: [];
					const planMarkdown = ctx.output?.content ?? "";
					return {
						state: patchRepositoryChangeState(ctx.state, {
							reviewSubject: planReviewSubject,
							clearReviewRefs: true,
							clearProductRefs: [products.simplificationPlan],
						}),
						processPatch: { planRevision },
						broadcasts: [
							{
								type: "plan.updated",
								payload: {
									planRevision,
									reviewState: "awaiting_approval",
									approved: false,
									summary,
								},
							},
						],
						emit: [
							{
								type: "plan_saved",
								data: {
									planRevision,
									summary,
									planMarkdown,
									acceptanceCriteria,
								},
							},
						],
					};
				}),
		)
		.publish(products.plan);

	const reviewPlanTurn = flow
		.llm<TParams, RepositoryChangeState>(turnIds.reviewPlan)
		.description("Review plan")
		.tools("read", "bash")
		.rootBranchReview()
		.startFromReviewBranch()
		.reviews(planReviewSubject)
		.consume(products.plan)
		.buildPrompt(buildReviewPlanPrompt)
		.outcomeTool("no_issues", (tool) =>
			tool
				.description(
					"Approve the plan and publish the review. Its Markdown may include Mermaid diagrams or uploaded images.",
				)
				.to(turnIds.planDecision)
				.state(({ ctx }) =>
					patchRepositoryChangeState(ctx.state, {
						reviewSubject: planReviewSubject,
					}),
				),
		)
		.outcomeTool("request_changes", (tool) =>
			tool
				.description(
					"Request plan changes and publish actionable feedback. Its Markdown may include Mermaid diagrams or uploaded images.",
				)
				.to(turnIds.planReviewFeedback)
				.state(({ ctx }) =>
					patchRepositoryChangeState(ctx.state, {
						reviewSubject: planReviewSubject,
					}),
				),
		)
		.publish(products.review);

	const implementTurn = flow
		.llm<TParams, RepositoryChangeState>(turnIds.implement)
		.description("Implement change")
		.tools(...implementationTurnAvailableTools)
		.freshSeededPrimary()
		.continueFromProductBranch(products.simplificationPlan, {
			kind: "semantic_ref",
			ref: "review",
			fallback: { kind: "session_root" },
		})
		.consume(products.plan)
		.buildPrompt(buildImplementPrompt)
		.publish(products.implementationSummary)
		.to(turnIds.implementationDecision)
		.state(({ ctx }) =>
			patchRepositoryChangeState(ctx.state, {
				reviewSubject: implementationReviewSubject,
				clearReviewRefs: true,
				clearProductRefs: [products.simplificationPlan],
			}),
		);

	const reviewImplementationTurn = flow
		.llm<TParams, RepositoryChangeState>(turnIds.reviewImplementation)
		.description("Review implementation")
		.tools("read", "bash")
		.rootBranchReview()
		.startFromReviewBranch()
		.reviews(implementationReviewSubject)
		.buildPrompt(buildReviewImplementationPrompt)
		.outcomeTool("no_issues", (tool) =>
			tool
				.description(
					"Approve the implementation and publish the review. Its Markdown may include Mermaid diagrams or uploaded images.",
				)
				.to(turnIds.implementationDecision)
				.state(({ ctx }) =>
					patchRepositoryChangeState(ctx.state, {
						reviewSubject: implementationReviewSubject,
					}),
				),
		)
		.outcomeTool("request_changes", (tool) =>
			tool
				.description(
					"Request implementation changes and publish actionable feedback. Its Markdown may include Mermaid diagrams or uploaded images.",
				)
				.to(turnIds.implementationReviewFeedback)
				.state(({ ctx }) =>
					patchRepositoryChangeState(ctx.state, {
						reviewSubject: implementationReviewSubject,
					}),
				),
		)
		.publish(products.review);

	const simplifyImplementationTurn = flow
		.llm<TParams, RepositoryChangeState>(turnIds.simplifyImplementation)
		.description("Simplify implementation")
		.tools("read", "bash")
		.rootBranchReview()
		.startFromProductBranch(products.simplificationPlan)
		.buildPrompt(buildSimplifyImplementationPrompt)
		.publish(products.simplificationPlan)
		.to(turnIds.simplificationDecision)
		.state(({ ctx }) =>
			patchRepositoryChangeState(ctx.state, {
				reviewSubject: implementationReviewSubject,
			}),
		);

	const generateCommitMessageTurn = flow
		.llm<TParams, RepositoryChangeState>(turnIds.generateCommitMessage)
		.description("Generate commit message")
		.modelPurpose("process_title_generation")
		.rootBranchReview()
		.startFromRoot()
		.consume(products.plan)
		.buildPrompt(buildGenerateCommitMessagePrompt)
		.publish(products.commitMessage)
		.to(turnIds.commitAndMerge)
		.state(({ ctx }) =>
			patchRepositoryChangeState(ctx.state, {
				finalization: {
					...ctx.state.finalization,
					generatedCommitMessage: normalizeGeneratedCommitMessage(ctx.output?.content),
				},
			}),
		);

	const commitAndMergeTurn = flow
		.automatic<TParams, RepositoryChangeState>(turnIds.commitAndMerge)
		.description(config.finalizationDescription)
		.run(runDeterministicFinalization)
		.outcome("merge_conflict", (outcome) =>
			outcome
				.description("Deterministic merge hit conflicts and needs conflict resolution")
				.requiredString("headSha", "The current HEAD sha while the merge conflict is active")
				.stringArray("conflictedFiles", "Conflicted files that need resolution")
				.string("fetchedBaseSha", "The fetched origin/<baseBranch> sha when available")
				.to(turnIds.resolveMergeConflict)
				.state(({ ctx }) =>
					patchRepositoryChangeState(ctx.state, {
						finalization: resetFinalizationAfterMessage(ctx.state),
					}),
				),
		)
		.outcome("finalized", (outcome) =>
			outcome
				.description("Deterministic finalization succeeded")
				.requiredString("headSha", "The final HEAD sha")
				.requiredString("mergeMode", "How origin/<baseBranch> was integrated")
				.requiredString("pushTarget", "The final base-branch publish target")
				.requiredBoolean("usedConflictResolution", "Whether the merge required conflict resolution")
				.complete()
				.state(({ ctx, event }) =>
					patchRepositoryChangeState(ctx.state, {
						reviewSubject: null,
						finalization: resetFinalizationAfterMessage(ctx.state, {
							usedConflictResolution:
								event.params.usedConflictResolution === true ||
								ctx.state.finalization.usedConflictResolution,
							finalizationSummaryMarkdown: normalizeOptionalMarkdown(ctx.output?.content),
							finalizedHeadSha: normalizeMessage(event.params.headSha),
						}),
					}),
				),
		);

	const resolveMergeConflictTurn = flow
		.llm<TParams, RepositoryChangeState>(turnIds.resolveMergeConflict)
		.description("Resolve merge conflict")
		.tools("read", "bash", "edit", "write")
		.fullPrimary()
		.startFromRoot()
		.buildPrompt(buildResolveMergeConflictPrompt)
		.outcomeTool("clean", (tool) =>
			tool
				.description("The merge conflict was resolved and the repository is clean")
				.requiredString("headSha", "The post-resolution HEAD sha")
				.to(turnIds.commitAndMerge)
				.state(({ ctx, event }) =>
					patchRepositoryChangeState(ctx.state, {
						finalization: resetFinalizationAfterMessage(ctx.state, {
							expectedPostConflictHeadSha: normalizeMessage(event.params.headSha),
							usedConflictResolution: true,
						}),
					}),
				),
		)
		.publish(products.mergeResolutionSummary);

	const planFlow = flow
		.fragment<TParams, RepositoryChangeState>("plan")
		.turn(importPlanTurn)
		.turn(generatePlanTurn)
		.turn({ id: turnIds.planDecision, definition: planDecisionSpec })
		.turn(reviewPlanTurn)
		.turn({ id: turnIds.planReviewFeedback, definition: planReviewFeedbackSpec });

	const implementationFlow = flow
		.fragment<TParams, RepositoryChangeState>("implementation")
		.turn(implementTurn)
		.turn({ id: turnIds.implementationDecision, definition: implementationDecisionSpec })
		.turn(reviewImplementationTurn)
		.turn({
			id: turnIds.implementationReviewFeedback,
			definition: implementationReviewFeedbackSpec,
		})
		.turn(simplifyImplementationTurn)
		.turn({ id: turnIds.simplificationDecision, definition: simplificationDecisionSpec });

	const finalizationFlow = flow
		.fragment<TParams, RepositoryChangeState>("finalization")
		.turn(generateCommitMessageTurn)
		.turn(commitAndMergeTurn)
		.turn(resolveMergeConflictTurn);

	const builder = flow
		.process<TParams, RepositoryChangeState>(config.processId)
		.displayName(config.displayName)
		.entry(turnIds.generatePlan)
		.alternateEntry(turnIds.importPlan)
		.happyPath(
			turnIds.generatePlan,
			turnIds.implement,
			turnIds.generateCommitMessage,
			turnIds.commitAndMerge,
		)
		.piConfig({ sessionCwdTemplate: "{{{projectKey}}}" })
		.codecs({
			params: config.paramsCodec,
			state: repositoryChangeStateCodec,
		})
		.initialState(() => ({
			...createEmptyStructuralProcessState(),
			finalization: createEmptyRepositoryChangeFinalizationState(),
		}))
		.use(planFlow)
		.use(implementationFlow)
		.use(finalizationFlow);
	if (config.repositoryCredentials) builder.repositoryCredentials(config.repositoryCredentials);
	const process = builder.launcher(config.launcher).define();
	const decision = (id: string) =>
		({
			id,
			...(process.turns.get(id)?.definition as HumanTurnDefinition),
		}) as HumanTurnDefinition & { id: string };
	return {
		process,
		planDecision: decision(turnIds.planDecision),
		planReviewFeedback: decision(turnIds.planReviewFeedback),
		implementationDecision: decision(turnIds.implementationDecision),
		implementationReviewFeedback: decision(turnIds.implementationReviewFeedback),
		simplificationDecision: decision(turnIds.simplificationDecision),
	};
}

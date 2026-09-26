import { trimString as normalizeMessage, normalizeOptionalMarkdown } from "@leitwerk-dev/domain";
import {
	acceptedReviewHandoffAction,
	type Codec,
	createEmptyStructuralProcessState,
	type FlowFragmentBuilder,
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
import {
	clearReviewRefs,
	createEmptyRepositoryChangeFinalizationState,
	type RepositoryChangeState,
	repositoryChangeStateCodec,
} from "./repository-change-state-internal.js";
import { codingPurposes } from "./settings.js";
import {
	buildGenerateCommitMessagePrompt,
	normalizeGeneratedCommitMessage,
} from "./turns/generate-commit-message.js";
import { buildGeneratePlanPrompt } from "./turns/generate-plan.js";
import { buildImplementPrompt } from "./turns/implement.js";
import { buildReviewImplementationPrompt } from "./turns/review-implementation.js";
import { buildReviewPlanPrompt } from "./turns/review-plan.js";
import { buildSimplifyImplementationPrompt } from "./turns/simplify-implementation.js";

/** @public */
export type RepositoryChangeParams = object;

/** @public */
export interface RepositoryChangeProcessConfig<TParams extends RepositoryChangeParams> {
	/** @public */
	processId: string;
	/** @public */
	displayName: string;
	/** @public */
	paramsCodec: Codec<TParams>;
	/** @public */
	launcher?: ProcessLauncherDefinition<TParams>;
	/** @public */
	finalizeLabel: string;
	/** @public */
	finalizeForm: FormDefinition;
	/** @public */
	repositoryCredentials?(input: {
		/** @public */
		params: TParams;
		/** @internal */
		projects: readonly RepositoryCredentialProject[];
	}): readonly RepositoryCredentialRequirement[];
	/** @public */
	publication: {
		/** @public */
		entryTurnId: string;
		/** @public */
		fragment: FlowFragmentBuilder<TParams, RepositoryChangeState>;
		/** @public */
		happyPath?: readonly string[];
	};
}

/** @public */
export function createRepositoryChangeProcess<TParams extends RepositoryChangeParams>(
	config: RepositoryChangeProcessConfig<TParams>,
) {
	const turnIds = {
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
	} as const;

	const products = {
		plan: "plan",
		review: "review",
		simplificationPlan: "simplification-plan",
		implementationSummary: "implementation-summary",
		commitMessage: "commit-message",
	} as const;

	const implementationTurnAvailableTools = ["read", "bash", "edit", "write"] as const;

	function hasResolvedTurnRecordRef(
		ref: RepositoryChangeState["semanticEntryRefs"][keyof RepositoryChangeState["semanticEntryRefs"]],
	): ref is { entryId: string; turnRecordId: string } {
		return typeof ref?.turnRecordId === "string" && ref.turnRecordId.trim() !== "";
	}

	function requireResolvedPlanRef(
		plan: RepositoryChangeState["semanticEntryRefs"][keyof RepositoryChangeState["semanticEntryRefs"]],
		usage: "approval" | "review" | "simplification review" | "implementation review",
	): asserts plan is { entryId: string; turnRecordId: string } {
		if (!hasResolvedTurnRecordRef(plan)) {
			throw new Error(`No plan is available for ${usage}`);
		}
	}

	function clearReviewState(state: RepositoryChangeState): RepositoryChangeState {
		return patchRepositoryChangeState(state, {
			clearReviewRefs: true,
			clearProductRefs: [products.simplificationPlan],
		});
	}

	function buildAcceptedFollowUpMessage(input: {
		kind: "plan_review" | "implementation_review" | "simplification";
		markdown: unknown;
		adjustment: unknown;
	}): string {
		const markdown = normalizeOptionalMarkdown(input.markdown);
		if (!markdown) {
			throw new Error(
				input.kind === "simplification"
					? "No simplification plan markdown is available to accept"
					: "No review output markdown is available to accept",
			);
		}
		const adjustment = normalizeMessage(input.adjustment);
		const subject = input.kind === "simplification" ? "simplification plan" : "review";
		const introduction =
			input.kind === "plan_review"
				? "Revise the plan according to this review:"
				: `Implement according to this ${subject}:`;
		const sections = [introduction, markdown];
		if (adjustment) {
			sections.push(
				`Also follow this adjustment where it conflicts with the ${subject}:`,
				adjustment,
			);
		}
		if (input.kind !== "plan_review") {
			sections.push(
				[
					"This is now an implementation turn. Ignore earlier review-only or read-only instructions.",
					"You may change files in the repository workspace.",
					`Use the available tools (${implementationTurnAvailableTools.join(", ")}) to inspect, edit, build, and test the change.`,
					"When finished, return an implementation summary.",
				].join("\n"),
			);
		}
		return sections.join("\n\n");
	}

	function patchRepositoryChangeState(
		state: RepositoryChangeState,
		input: {
			finalization?: RepositoryChangeState["finalization"];
			clearReviewRefs?: boolean;
			clearProductRefs?: readonly string[];
		},
	): RepositoryChangeState {
		const nextState: RepositoryChangeState = {
			...state,
			...("finalization" in input ? { finalization: input.finalization } : {}),
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
		description: "Review Plan",
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
					requireResolvedPlanRef(ctx.state.semanticEntryRefs.plan, "approval");
					return {
						state: clearReviewState(ctx.state),
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
						state: clearReviewState(ctx.state),
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
					requireResolvedPlanRef(ctx.state.semanticEntryRefs.plan, "review");
					return {
						state: clearReviewState(ctx.state),
					};
				},
			},
		},
	});

	const planReviewFeedbackSpec = humanTurn<TParams, RepositoryChangeState>({
		description: "Review Plan Feedback",
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
				resolveBodyMarkdown: ({ ctx, input }) =>
					buildAcceptedFollowUpMessage({
						kind: "plan_review",
						markdown: ctx.readSemanticTurnResultMarkdown("review"),
						adjustment: input.message,
					}),
			}),
			[codingActionIds.requestReviewChanges]: revisionAction({
				label: "Request review changes",
				description: "Ask the LLM reviewer to revise its plan review.",
				acceptanceState: "requires_changes",
				form: requestReviewChangesForm,
				to: turnIds.reviewPlan,
				queueTarget: { semanticRef: "review" },
			}),
			[codingActionIds.dismissReview]: {
				label: "Dismiss review",
				description: "Return to the plan decision without applying the review.",
				acceptanceState: "neutral",
				to: turnIds.planDecision,
			},
		},
	});

	const implementationDecisionSpec = humanTurn<TParams, RepositoryChangeState>({
		description: "Review",
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
			"Publish this implementation, request another pass, simplify it, or run an automated review.",
		actions: {
			[codingActionIds.finalizeChange]: {
				label: config.finalizeLabel,
				acceptanceState: "accepted",
				form: config.finalizeForm,
				schedulable: true,
				to: turnIds.generateCommitMessage,
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
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
					state: clearReviewState(ctx.state),
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
					return { state: clearReviewState(ctx.state) };
				},
			},
			[codingActionIds.runReview]: {
				label: "Run automated review",
				acceptanceState: "neutral",
				schedulable: true,
				to: turnIds.reviewImplementation,
				effect: ({ ctx }) => {
					requireResolvedPlanRef(ctx.state.semanticEntryRefs.plan, "implementation review");
					return { state: clearReviewState(ctx.state) };
				},
			},
		},
	});

	const implementationReviewFeedbackSpec = humanTurn<TParams, RepositoryChangeState>({
		description: "Review implementation feedback",
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
				resolveBodyMarkdown: ({ ctx, input }) =>
					buildAcceptedFollowUpMessage({
						kind: "implementation_review",
						markdown: ctx.readSemanticTurnResultMarkdown("review"),
						adjustment: input.message,
					}),
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
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
			}),
			[codingActionIds.dismissReview]: {
				label: "Dismiss review",
				acceptanceState: "neutral",
				to: turnIds.implementationDecision,
			},
		},
	});

	const simplificationDecisionSpec = humanTurn<TParams, RepositoryChangeState>({
		description: "Review simplification plan",
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
				resolveBodyMarkdown: ({ ctx, input }) =>
					buildAcceptedFollowUpMessage({
						kind: "simplification",
						markdown: ctx.readProductTurnResultMarkdown(products.simplificationPlan),
						adjustment: input.message,
					}),
				effect: ({ ctx }) => ({
					state: patchRepositoryChangeState(ctx.state, {
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
			}),
			[codingActionIds.dismissReview]: {
				label: "Reject simplification plan",
				description:
					"Return to the implementation decision without applying the simplification plan.",
				acceptanceState: "neutral",
				to: turnIds.implementationDecision,
				effect: ({ ctx }) => ({
					state: clearReviewState(ctx.state),
				}),
			},
		},
	});

	const generatePlanTurn = flow
		.llm<TParams, RepositoryChangeState>(turnIds.generatePlan)
		.description("Plan")
		.executionPurpose(codingPurposes.planning)
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
						state: clearReviewState(ctx.state),
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
		.description("Assess Plan")
		.executionPurpose(codingPurposes.review)
		.tools("read", "bash")
		.rootBranchReview()
		.startFromReviewBranch()
		.consume(products.plan)
		.buildPrompt(buildReviewPlanPrompt)
		.outcomeTool("no_issues", (tool) =>
			tool
				.description(
					"Approve the plan and publish the review. Its Markdown may include Mermaid diagrams or uploaded images.",
				)
				.to(turnIds.planDecision),
		)
		.outcomeTool("request_changes", (tool) =>
			tool
				.description(
					"Request plan changes and publish actionable feedback. Its Markdown may include Mermaid diagrams or uploaded images.",
				)
				.to(turnIds.planReviewFeedback),
		)
		.publish(products.review);

	const implementTurn = flow
		.llm<TParams, RepositoryChangeState>(turnIds.implement)
		.description("Implement")
		.executionPurpose(codingPurposes.implementation)
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
		.state(({ ctx }) => clearReviewState(ctx.state));

	const reviewImplementationTurn = flow
		.llm<TParams, RepositoryChangeState>(turnIds.reviewImplementation)
		.description("Assess Implementation")
		.executionPurpose(codingPurposes.review)
		.tools("read", "bash")
		.rootBranchReview()
		.startFromReviewBranch()
		.buildPrompt(buildReviewImplementationPrompt)
		.outcomeTool("no_issues", (tool) =>
			tool
				.description(
					"Approve the implementation and publish the review. Its Markdown may include Mermaid diagrams or uploaded images.",
				)
				.to(turnIds.implementationDecision),
		)
		.outcomeTool("request_changes", (tool) =>
			tool
				.description(
					"Request implementation changes and publish actionable feedback. Its Markdown may include Mermaid diagrams or uploaded images.",
				)
				.to(turnIds.implementationReviewFeedback),
		)
		.publish(products.review);

	const simplifyImplementationTurn = flow
		.llm<TParams, RepositoryChangeState>(turnIds.simplifyImplementation)
		.description("Simplify")
		.executionPurpose(codingPurposes.review)
		.tools("read", "bash")
		.rootBranchReview()
		.startFromProductBranch(products.simplificationPlan)
		.buildPrompt(buildSimplifyImplementationPrompt)
		.publish(products.simplificationPlan)
		.to(turnIds.simplificationDecision);

	const generateCommitMessageTurn = flow
		.llm<TParams, RepositoryChangeState>(turnIds.generateCommitMessage)
		.description("Write Commit Message")
		.executionPurpose(codingPurposes.implementation)
		.modelPurpose("process_title_generation")
		.rootBranchReview()
		.startFromRoot()
		.consume(products.plan)
		.buildPrompt(buildGenerateCommitMessagePrompt)
		.publish(products.commitMessage)
		.to(config.publication.entryTurnId)
		.state(({ ctx }) =>
			patchRepositoryChangeState(ctx.state, {
				finalization: {
					...ctx.state.finalization,
					generatedCommitMessage: normalizeGeneratedCommitMessage(ctx.output?.content),
				},
			}),
		);

	const planFlow = flow
		.fragment<TParams, RepositoryChangeState>("plan")
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
		.turn(generateCommitMessageTurn);

	const builder = flow
		.process<TParams, RepositoryChangeState>(config.processId)
		.displayName(config.displayName)
		.entry(turnIds.generatePlan)
		.happyPath(
			turnIds.generatePlan,
			turnIds.implement,
			turnIds.generateCommitMessage,
			...(config.publication.happyPath ?? [config.publication.entryTurnId]),
		)
		.piConfig({ sessionCwdTemplate: "{{{projectKey}}}" })
		.codecs({
			params: config.paramsCodec,
			state: repositoryChangeStateCodec,
		})
		.initialState(() => ({
			...createEmptyStructuralProcessState(),
			finalization: createEmptyRepositoryChangeFinalizationState(),
			extensionState: {},
		}))
		.use(planFlow)
		.use(implementationFlow)
		.use(finalizationFlow);
	builder.use(config.publication.fragment);
	if (config.repositoryCredentials) builder.repositoryCredentials(config.repositoryCredentials);
	if (config.launcher) builder.launcher(config.launcher);
	const process = builder.define();
	const decision = (id: string) =>
		({
			/** @public */
			id,
			...(process.turns.get(id)?.definition as HumanTurnDefinition),
		}) as HumanTurnDefinition & {
			/** @public */ id: string;
		};
	return {
		/** @public */
		process,
		/** @internal */
		planDecision: decision(turnIds.planDecision),
		/** @internal */
		planReviewFeedback: decision(turnIds.planReviewFeedback),
		/** @internal */
		implementationDecision: decision(turnIds.implementationDecision),
		/** @internal */
		implementationReviewFeedback: decision(turnIds.implementationReviewFeedback),
		/** @internal */
		simplificationDecision: decision(turnIds.simplificationDecision),
	};
}

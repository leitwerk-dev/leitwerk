import { trimString as normalizeMessage } from "@leitwerk-dev/domain";
import {
	type Codec,
	type ExternalActionSource,
	type FlowFragmentBuilder,
	type FormDefinition,
	flow,
	humanTurn,
	type ProcessLauncherDefinition,
	type RepositoryCredentialProject,
	type RepositoryCredentialRequirement,
	revisionAction,
} from "@leitwerk-dev/process-sdk";
import { codingActionIds, requestRevisionForm } from "./actions.js";
import {
	type RepositoryChangeState,
	repositoryChangeStateCodec,
} from "./repository-change-state-internal.js";
import { codingPurposes } from "./settings.js";
import {
	buildRepositoryCommitMessagesPrompt,
	parseRepositoryCommitMessages,
} from "./turns/generate-commit-message.js";
import { buildGeneratePlanPrompt } from "./turns/generate-plan.js";
import { buildImplementPrompt } from "./turns/implement.js";
import { buildStreamlinedSimplificationPrompt } from "./turns/simplify-implementation.js";

/** @public */
export type RepositoryChangeParams = object;

/** Server-side policies evaluated at the route boundary. @public */
export interface RepositoryChangeWorkflow<TParams> {
	/** @deprecated All repository changes use the streamlined graph. @public */
	variant?: "streamlined";
	/** @public */
	multiRepository?: boolean;
	/** @public */
	planDecision?(params: TParams): Promise<{
		/** @internal */
		skip: boolean;
		/** @internal */
		reason: string;
	}>;
	/** @public */
	simplification?(params: TParams): Promise<{
		/** @internal */
		skip: boolean;
		/** @internal */
		reason: string;
	}>;
	/** Must recheck the current revision and source before firing. @public */
	planBypassSource?: ExternalActionSource<TParams, RepositoryChangeState, unknown>;
}

/** @public */
export interface RepositoryChangeProcessConfig<TParams extends RepositoryChangeParams> {
	/** @public */
	processId: string;
	/** @public */
	displayName: string;
	/** @public */
	workflow?: RepositoryChangeWorkflow<TParams>;
	/** @public */
	paramsCodec: Codec<TParams>;
	/** @public */
	launcher?: ProcessLauncherDefinition<TParams>;
	/** @deprecated Publication follows implementation automatically. @public */
	finalizeLabel?: string;
	/** @deprecated Publication follows implementation automatically. @public */
	finalizeForm?: FormDefinition;
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
	const tools = ["read", "bash", "edit", "write"] as const;
	const planDecision = humanTurn<TParams, RepositoryChangeState>({
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
		commentary: "Approve this plan or request a revision with comments.",
		actions: {
			[codingActionIds.approvePlan]: {
				label: "Approve plan",
				description: "Accept the current plan and continue into implementation.",
				acceptanceState: "accepted",
				to: "implement",
				effect: ({ ctx }) => {
					if (!ctx.state.semanticEntryRefs.plan?.turnRecordId?.trim())
						throw new Error("No plan is available for approval");
					return {
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
				to: "generate_plan",
				queueTarget: { semanticRef: "currentPrimaryPathLeaf" },
				effect: ({ input }) => ({
					emit: [
						{ type: "plan_revision_requested", data: { message: normalizeMessage(input.message) } },
					],
				}),
			}),
		},
	});
	if (config.workflow?.planBypassSource)
		planDecision.externalActions = {
			bypass_plan: {
				id: "bypass_plan",
				label: "Skip plan approval",
				source: config.workflow.planBypassSource,
				to: "implement",
				effect: ({ state, process, event }) => {
					if ((event as { planRevision?: number }).planRevision !== process.planRevision)
						throw new Error("Stale plan bypass event");
					return {
						state: {
							...state,
							routing: {
								...state.routing,
								plan: { planRevision: process.planRevision, skip: true, reason: "Jira label" },
							},
						},
						emit: [
							{
								type: "plan_approved" as const,
								data: {
									planRevision: process.planRevision,
									actor: "system",
									bypassed: true,
									reason: "Jira label",
								},
							},
						],
					};
				},
			},
		};

	const generatePlan = flow
		.llm<TParams, RepositoryChangeState>("generate_plan")
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
				.routeByState({ approval: "plan_decision", bypass: "implement" }, ({ ctx }) =>
					ctx.state.routing?.plan?.skip ? "bypass" : "approval",
				)
				.effect(async ({ ctx, event }) => {
					const planRevision = ctx.process.planRevision + 1;
					const policy = (await config.workflow
						?.planDecision?.(ctx.params)
						.catch(() => ({ skip: false, reason: "Source unavailable; approval required" }))) ?? {
						skip: false,
						reason: "Human approval required",
					};
					const summary = normalizeMessage(event.params.summary);
					const acceptanceCriteria = Array.isArray(event.params.acceptanceCriteria)
						? event.params.acceptanceCriteria.filter(
								(entry): entry is string => typeof entry === "string" && entry.trim() !== "",
							)
						: [];
					return {
						state: {
							...ctx.state,
							routing: { ...ctx.state.routing, plan: { ...policy, planRevision } },
						},
						processPatch: { planRevision },
						broadcasts: [
							{
								type: "plan.updated",
								payload: {
									planRevision,
									reviewState: policy.skip ? "accepted" : "awaiting_approval",
									approved: policy.skip,
									summary,
								},
							},
						],
						emit: [
							...(policy.skip
								? [
										{
											type: "plan_approved" as const,
											data: {
												planRevision,
												actor: "system",
												bypassed: true,
												reason: policy.reason,
											},
										},
									]
								: []),
							{
								type: "plan_saved",
								data: {
									planRevision,
									summary,
									planMarkdown: ctx.output?.content ?? "",
									acceptanceCriteria,
								},
							},
						],
					};
				}),
		)
		.publish("plan");
	const implement = flow
		.llm<TParams, RepositoryChangeState>("implement")
		.description("Implement")
		.waitFor(({ state }) => !!state.productRefs.plan)
		.executionPurpose(codingPurposes.implementation)
		.tools(...tools)
		.freshSeededPrimary()
		.startFromRoot()
		.consume("plan")
		.buildPrompt(buildImplementPrompt)
		.outcomeTool("implementation_ready", (tool) =>
			tool
				.description("Implementation and checks are complete; continue to delivery")
				.routeByState(
					{ simplify: "simplify_implementation", skip: "generate_commit_message" },
					({ ctx }) => (ctx.state.routing?.simplification?.skip ? "skip" : "simplify"),
				)
				.effect(async ({ ctx }) => ({
					state: {
						...ctx.state,
						routing: {
							...ctx.state.routing,
							simplification: ctx.state.routing?.simplification ??
								(await config.workflow?.simplification?.(ctx.params)) ?? {
									skip: false,
									reason: "Simplification enabled by default",
								},
						},
					},
				})),
		)
		.publish("implementation-summary");
	const simplify = flow
		.llm<TParams, RepositoryChangeState>("simplify_implementation")
		.description("Simplify")
		.executionPurpose(codingPurposes.review)
		.tools("read", "bash")
		.rootBranchReview()
		.startFromProductBranch("simplification-plan")
		.buildPrompt(buildStreamlinedSimplificationPrompt)
		.publish("simplification-plan")
		.to("apply_simplification");
	const applySimplification = flow
		.llm<TParams, RepositoryChangeState>("apply_simplification")
		.description("Apply simplification")
		.executionPurpose(codingPurposes.implementation)
		.tools(...tools)
		.freshSeededPrimary()
		.consume("plan")
		.consume("simplification-plan")
		.buildPrompt(
			(
				ctx,
			) => `Apply justified simplifications to each repository, preserving the accepted plan and behavior. Rerun the required checks. Empty findings require no edits. Leave changes uncommitted for delivery.

Accepted plan:
${ctx.input.plan}

Findings by repository:
${ctx.input["simplification-plan"]}`,
		)
		.publish("implementation-summary")
		.to("generate_commit_message");
	const generateCommitMessage = flow
		.llm<TParams, RepositoryChangeState>("generate_commit_message")
		.description("Write Commit Message")
		.executionPurpose(codingPurposes.implementation)
		.rootBranchReview()
		.startFromRoot()
		.consume("plan")
		.buildPrompt(buildRepositoryCommitMessagesPrompt)
		.publish("commit-message")
		.to(config.publication.entryTurnId)
		.state(({ ctx }) => ({
			...ctx.state,
			finalization: {
				...ctx.state.finalization,
				commitMessages: parseRepositoryCommitMessages(
					ctx.output?.content,
					ctx.projects.map((p) => p.key),
				),
			},
		}));
	const builder = flow
		.process<TParams, RepositoryChangeState>(config.processId)
		.displayName(config.displayName)
		.entry("generate_plan")
		.happyPath(
			"generate_plan",
			"implement",
			"simplify_implementation",
			"apply_simplification",
			"generate_commit_message",
			...(config.publication.happyPath ?? [config.publication.entryTurnId]),
		)
		.piConfig(config.workflow?.multiRepository ? {} : { sessionCwdTemplate: "{{{projectKey}}}" })
		.codecs({ params: config.paramsCodec, state: repositoryChangeStateCodec })
		.initialState(() => repositoryChangeStateCodec.parse({}))
		.turn(generatePlan)
		.turn({ id: "plan_decision", definition: planDecision })
		.turn(implement)
		.turn(simplify)
		.turn(applySimplification)
		.turn(generateCommitMessage)
		.use(config.publication.fragment);
	if (config.repositoryCredentials) builder.repositoryCredentials(config.repositoryCredentials);
	if (config.launcher) builder.launcher(config.launcher);
	return {
		/** @public */
		process: builder.define(),
	};
}

import {
	type ExtensionProcessDefinition,
	humanTurn,
	type TurnDefinition,
} from "@leitwerk-dev/process-sdk";
import {
	buildPlanSavedEventPayload,
	buildReviewCompletedEventPayload,
	buildReviewRequestedEventPayload,
} from "@leitwerk-dev/process-sdk/review-flow";
import { getDefaultConfig } from "../config/config-loader.js";
import type { RepositoryBundle } from "../db/repositories.js";
import { buildProcessActionRegistry } from "../process-action-registry.js";
import { createProcessEngine } from "../process-engine/engine.js";
import { getProcessGraph, type ProcessGraphView } from "../process-graph.js";
import { createServerProcessModelPolicy } from "../process-model-policy/index.js";
import { createProcessOperationCoordinator } from "../process-operation-coordinator.js";
import { createProcessQuestionService } from "../process-question-service.js";
import { createIpcHandler } from "../supervisor/ipc-handler.js";
import type { createBroadcaster } from "../ws/broadcast.js";
import { defineGraphFixtureProcess } from "./process-binding-fixtures.js";
import { createDefaultTestProcessGraphRegistry } from "./process-fixtures.js";
import {
	createBuildFixOutcomeTools,
	createBuildVerificationOutcomeTools,
	createCommentsAddressedOutcomeTools,
	createCommittedOutcomeTools,
	createDoneOutcomeTools,
	createPlanSavedOutcomeTools,
	createReviewOutcomeTools,
	createTestLlmTurn,
} from "./turn-fixtures.js";

export interface TestIpcHandlerDeps
	extends Pick<
		RepositoryBundle,
		| "processes"
		| "launchRuns"
		| "projects"
		| "questionRequests"
		| "inputs"
		| "events"
		| "futureExecutions"
		| "pendingExternalSourceFires"
		| "leafOutcomeSnapshots"
		| "turnRecords"
		| "turnStarts"
		| "turnAnnotations"
		| "leases"
		| "transaction"
	> {
	broadcaster: ReturnType<typeof createBroadcaster>;
}

interface TestProcessState {
	readyForHumanReview: boolean;
}

const testProcessGraphRegistry = createDefaultTestProcessGraphRegistry();
const ticketTurnGraph = getProcessGraph(testProcessGraphRegistry, "ticket_issue_process");
const mrPolishGraph = getProcessGraph(testProcessGraphRegistry, "mr_polish_process");

function buildTestProcessTurnDefinitions(
	graph: ProcessGraphView,
): ReadonlyMap<string, TurnDefinition<Record<string, never>, TestProcessState>> {
	return new Map(
		[...graph.turns.entries()].map(([turnId, turnGraph]) => {
			const baseDefinition = testTurns.get(turnId);
			if (!baseDefinition) {
				throw new Error(`Missing test turn definition for '${turnId}'`);
			}
			const definition =
				baseDefinition.kind === "llm"
					? {
							...baseDefinition,
							...(turnGraph.resultSemanticRef
								? { resultSemanticRef: turnGraph.resultSemanticRef }
								: {}),
							...(turnGraph.requiredSemanticMarkdownRefs?.length
								? {
										requiredSemanticMarkdownRefs: [...turnGraph.requiredSemanticMarkdownRefs],
									}
								: {}),
							...(turnGraph.optionalSemanticMarkdownRefs?.length
								? {
										optionalSemanticMarkdownRefs: [...turnGraph.optionalSemanticMarkdownRefs],
									}
								: {}),
						}
					: baseDefinition;
			return [turnId, definition] as const;
		}),
	);
}

function createTestProcess(
	id: string,
	graph: ProcessGraphView,
	server: NonNullable<
		ExtensionProcessDefinition<Record<string, never>, TestProcessState>["server"]
	>,
): ExtensionProcessDefinition<Record<string, never>, TestProcessState> {
	const [entryTurnId] = graph.entryTurnIds;
	if (!entryTurnId) {
		throw new Error(`Test process '${id}' is missing an entry turn`);
	}
	return defineGraphFixtureProcess<Record<string, never>, TestProcessState>({
		id,
		displayName: id,
		graph: { entryTurnId, turns: graph.turns },
		turnDefinitions: buildTestProcessTurnDefinitions(graph),
		paramsCodec: { parse: () => ({}), serialize: (value: Record<string, never>) => value },
		stateCodec: {
			parse(value: unknown) {
				const record =
					typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
				return {
					readyForHumanReview: record.readyForHumanReview === true,
				};
			},
			serialize(value: TestProcessState) {
				return value;
			},
		},
		initialState() {
			return { readyForHumanReview: false };
		},
		server,
	});
}

const testTurns = new Map<string, TurnDefinition<Record<string, never>, TestProcessState>>([
	[
		"plan_review",
		humanTurn({
			description: "Plan review",
			reviewSemanticRef: "plan",
			actions: {
				request_revision: {
					label: "Request revision",
					acceptanceState: "requires_changes",
				},
				approve_plan: { label: "Approve plan", acceptanceState: "accepted" },
			},
		}),
	],
	[
		"implementation_review",
		humanTurn({
			description: "Implementation review",
			reviewSemanticRef: "review",
			actions: {
				request_changes: {
					label: "Request changes",
					acceptanceState: "requires_changes",
				},
				mark_merged: { label: "Mark merged", acceptanceState: "accepted" },
			},
		}),
	],
	[
		"mr_polish_review",
		humanTurn({
			description: "MR polish review",
			reviewSemanticRef: "review",
			actions: {
				request_changes: {
					label: "Request changes",
					acceptanceState: "requires_changes",
				},
				mark_merged: { label: "Mark merged", acceptanceState: "accepted" },
			},
		}),
	],
	[
		"generate_plan",
		createTestLlmTurn<"plan_saved", Record<string, never>, TestProcessState>(
			"generate_plan",
			createPlanSavedOutcomeTools<Record<string, never>, TestProcessState>(),
		),
	],
	[
		"implement",
		createTestLlmTurn<"done", Record<string, never>, TestProcessState>(
			"implement",
			createDoneOutcomeTools<Record<string, never>, TestProcessState>({
				includeChangedProjects: true,
			}),
		),
	],
	[
		"handoff_review",
		createTestLlmTurn<"created", Record<string, never>, TestProcessState>("handoff_review", {
			created: { description: "created", parameters: {} },
		}),
	],
	[
		"address_review",
		createTestLlmTurn<"comments_addressed", Record<string, never>, TestProcessState>(
			"address_review",
			createCommentsAddressedOutcomeTools<Record<string, never>, TestProcessState>(),
		),
	],
	[
		"verify_build",
		createTestLlmTurn<"build_passing" | "build_failing", Record<string, never>, TestProcessState>(
			"verify_build",
			createBuildVerificationOutcomeTools<Record<string, never>, TestProcessState>(),
		),
	],
	[
		"fix_build",
		createTestLlmTurn<"build_fixed" | "build_unfixable", Record<string, never>, TestProcessState>(
			"fix_build",
			createBuildFixOutcomeTools<Record<string, never>, TestProcessState>(),
		),
	],
	[
		"run_llm_review",
		createTestLlmTurn<"issues_found" | "no_issues", Record<string, never>, TestProcessState>(
			"run_llm_review",
			createReviewOutcomeTools<Record<string, never>, TestProcessState>(),
		),
	],
	[
		"commit_and_complete",
		createTestLlmTurn<"committed", Record<string, never>, TestProcessState>(
			"commit_and_complete",
			createCommittedOutcomeTools<Record<string, never>, TestProcessState>(),
		),
	],
]);

const ticketTurnProcess = createTestProcess("ticket_issue_process", ticketTurnGraph, (api) => {
	api.onTurnOutcome("generate_plan", async (event, ctx) => {
		if (event.outcome !== "plan_saved") {
			return;
		}
		const planRevision = ctx.process.planRevision + 1;
		const planSaved = buildPlanSavedEventPayload({
			planRevision,
			event,
		});
		await ctx.transition({
			turnId: "plan_review",
			lifecycleStatus: "waiting",
		});
		ctx.applyLifecycleEffects?.({
			processPatch: { planRevision },
			broadcasts: [
				{
					type: "plan.updated",
					payload: {
						planRevision,
						reviewState: "awaiting_approval",
						approved: false,
						summary: planSaved.summary,
					},
				},
			],
		});
		ctx.emitEvent("plan_saved", planSaved);
	});

	api.onTurnOutcome("implement", async (event, ctx) => {
		if (event.outcome !== "done") {
			return;
		}
		ctx.emitEvent("review_requested", buildReviewRequestedEventPayload(event));
	});

	api.onTurnOutcome("run_llm_review", async (event, ctx) => {
		if (event.outcome === "issues_found") {
			const reviewCompleted = buildReviewCompletedEventPayload(event);
			await ctx.transition({
				turnId: "address_review",
				lifecycleStatus: "active",
			});
			ctx.applyLifecycleEffects?.({
				broadcasts: [
					{
						type: "review.updated",
						payload: { ...reviewCompleted, nextTurnId: null },
					},
				],
			});
			ctx.emitEvent("review_completed", reviewCompleted);
			return;
		}

		if (event.outcome === "no_issues") {
			const reviewCompleted = buildReviewCompletedEventPayload(event);
			await ctx.transition({
				turnId: "implementation_review",
				lifecycleStatus: "waiting",
			});
			ctx.applyLifecycleEffects?.({
				broadcasts: [
					{
						type: "review.updated",
						payload: { ...reviewCompleted, nextTurnId: null },
					},
				],
			});
			ctx.emitEvent("review_completed", reviewCompleted);
		}
	});

	api.onTurnOutcome("commit_and_complete", async (_event, ctx) => {
		await ctx.transition({
			state: {
				...ctx.state,
				readyForHumanReview: true,
			},
		});
	});
});

const mrPolishProcess = createTestProcess("mr_polish_process", mrPolishGraph, (api) => {
	api.onTurnOutcome("commit_and_complete", async (_event, ctx) => {
		await ctx.transition({
			state: {
				...ctx.state,
				readyForHumanReview: true,
			},
		});
	});
});

const testProcessGraphs = new Map<string, ExtensionProcessDefinition>([
	[ticketTurnProcess.id, ticketTurnProcess as ExtensionProcessDefinition],
	[mrPolishProcess.id, mrPolishProcess as ExtensionProcessDefinition],
]);

const testProcessActionRegistry = buildProcessActionRegistry({
	processes: testProcessGraphs,
});

export function createTestIpcHandler(
	deps: TestIpcHandlerDeps,
	callbacks: Parameters<typeof createIpcHandler>[1] & {
		onQuestionResponse?: Parameters<typeof createProcessQuestionService>[0]["sendQuestionResponse"];
		onQuestionRequested?: (
			instanceId: string,
			request: import("@leitwerk-dev/domain").ProcessQuestionRequest,
		) => void | Promise<void>;
	} = {},
	opts: {
		toastTtlMs?: number;
		workerEventLogger?: Parameters<typeof createIpcHandler>[0]["workerEventLogger"];
		appendDiagnosticTrace?: Parameters<typeof createIpcHandler>[0]["appendDiagnosticTrace"];
		handleIntegrationToolCancel?: Parameters<
			typeof createIpcHandler
		>[0]["handleIntegrationToolCancel"];
	} = {},
) {
	const processOperations = createProcessOperationCoordinator();
	const processModelPolicy = createServerProcessModelPolicy({
		config: getDefaultConfig(),
		processGraphs: testProcessGraphs,
		processActionRegistry: testProcessActionRegistry,
	});
	const getModelAvailabilitySnapshot = () => ({
		revision: 1,
		capturedAt: new Date().toISOString(),
		availabilityTransitions: [],
		profiles: getDefaultConfig().pi.model_profiles.map((profile) => ({
			profileId: profile.id,
			providerId: profile.provider,
			modelId: profile.model_id,
			availability: "available" as const,
			checkedAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		})),
	});
	const commands = createProcessEngine({
		processes: deps.processes,
		events: deps.events,
		futureExecutions: deps.futureExecutions,
		pendingExternalSourceFires: deps.pendingExternalSourceFires,
		projects: deps.projects,
		inputs: deps.inputs,
		leafOutcomeSnapshots: deps.leafOutcomeSnapshots,
		questionRequests: deps.questionRequests,
		turnRecords: deps.turnRecords,
		turnStarts: deps.turnStarts,
		leases: deps.leases,
		turnAnnotations: deps.turnAnnotations,
		transaction: deps.transaction,
		broadcaster: deps.broadcaster,
		toastTtlMs: opts.toastTtlMs ?? 6_000,
		processOperations,
		getSupervisor: () => undefined,
		processGraphs: testProcessGraphs,
		getProcessActionRegistry: () => testProcessActionRegistry,
		processModelPolicy,
		getModelAvailabilitySnapshot,
	});

	const processQuestions = createProcessQuestionService({
		repos: deps,
		processOperations,
		broadcaster: deps.broadcaster,
		getWorkerId: () => null,
		sendQuestionResponse: (instanceId, workerId, payload) =>
			callbacks.onQuestionResponse?.(instanceId, workerId, payload),
		emitQuestionRequested: (request) =>
			callbacks.onQuestionRequested?.(request.instanceId, request),
	});
	return createIpcHandler(
		{
			processes: deps.processes,
			projects: deps.projects,
			inputs: deps.inputs,
			events: deps.events,
			leases: deps.leases,
			turnRecords: deps.turnRecords,
			handleIntegrationToolCancel: opts.handleIntegrationToolCancel,
			processQuestions,
			broadcaster: deps.broadcaster,
			commands,
			workerEventLogger: opts.workerEventLogger,
			appendDiagnosticTrace: opts.appendDiagnosticTrace,
		},
		callbacks,
	);
}

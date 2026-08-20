import {
	type RepositoryChangeState as LocalRepoChangeState,
	resetRepositoryChangeFinalizationState as resetLocalRepoChangeFinalizationState,
} from "@leitwerk-dev/coding/repository-change-state";
import {
	buildProcessLaunchersForTest,
	buildServerProcessForTest,
	createTestProcessInstance,
	createTestServerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import {
	createEmptyStructuralProcessState,
	getProcessGraph,
	resolveHumanTurnView,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import {
	acceptReviewForm,
	finalizeChangeForm,
	localRepoChangeActionIds,
	requestReviewChangesForm,
	requestRevisionForm,
} from "./actions.js";
import {
	implementationDecision,
	implementationReviewFeedback,
	localRepoChangeProcess,
	planDecision,
	planReviewFeedback,
	simplificationDecision,
} from "./process-definition.js";

function sorted<T extends string>(iterable: Iterable<T>): T[] {
	return [...iterable].sort();
}

async function invokeAction(
	action: {
		plan?: (input: Record<string, unknown>, ctx: unknown) => Promise<void>;
		execute?: (input: Record<string, unknown>, ctx: unknown) => Promise<void>;
	},
	input: Record<string, unknown>,
	ctx: unknown,
) {
	const invoke = action.plan ?? action.execute;
	if (!invoke) {
		throw new Error("Action does not declare plan(...) or side-effect execute(...)");
	}
	return invoke(input, ctx);
}

function createState(overrides: Partial<LocalRepoChangeState> = {}): LocalRepoChangeState {
	return {
		...localRepoChangeProcess.initialState({
			launchKind: "requested_change",
			repoLocator: "/tmp/repo",
			baseBranch: "main",
			workBranch: "feature/test",
			prompt: "Ship the requested change",
		}),
		...overrides,
	};
}

function testContext(options: {
	selectedTurnId: string;
	lifecycleStatus?: "active" | "waiting";
	state?: LocalRepoChangeState;
	transition?: (next: unknown) => void | Promise<void>;
	queueInput?: (input: unknown) => void;
	readSemanticTurnResultMarkdown?: (ref: string) => string | null;
	readProductTurnResultMarkdown?: (productName: string) => string | null;
	emitEvent?: (type: string, payload: unknown) => void;
	applyLifecycleEffects?: (effects: unknown) => void;
}) {
	return createTestServerProcessContext({
		process: createTestProcessInstance({
			processId: localRepoChangeProcess.id,
			selectedTurnId: options.selectedTurnId,
			lifecycleStatus: options.lifecycleStatus ?? "waiting",
			planRevision: 2,
		}),
		params: {
			launchKind: "requested_change",
			repoLocator: "/tmp/repo",
			baseBranch: "main",
			workBranch: "feature/test",
			prompt: "Ship the requested change",
		},
		state: options.state ?? createState(),
		transition: async (next) => options.transition?.(next),
		queueInput: (input) => options.queueInput?.(input),
		readSemanticTurnResultMarkdown: options.readSemanticTurnResultMarkdown,
		readProductTurnResultMarkdown: options.readProductTurnResultMarkdown,
		emitEvent: options.emitEvent,
		applyLifecycleEffects: options.applyLifecycleEffects,
	});
}

function transitionsFor(turnId: string) {
	return getProcessGraph(
		new Map([[localRepoChangeProcess.id, localRepoChangeProcess]]),
		localRepoChangeProcess.id,
	).turns.get(turnId)?.transitions;
}

describe("localRepoChangeProcess", () => {
	it("declares the expected turn graph", () => {
		expect(localRepoChangeProcess.piConfig?.sessionCwdTemplate).toBe("{{{projectKey}}}");
		const graph = getProcessGraph(
			new Map([[localRepoChangeProcess.id, localRepoChangeProcess]]),
			localRepoChangeProcess.id,
		);
		expect(graph.primaryEntryTurnId).toBe("generate_plan");
		expect([...graph.entryTurnIds]).toEqual(["generate_plan", "import_plan"]);
		expect(sorted(localRepoChangeProcess.turns.keys())).toEqual([
			"commit_and_merge",
			"generate_commit_message",
			"generate_plan",
			"implement",
			"implementation_decision",
			"implementation_review_feedback",
			"import_plan",
			"plan_decision",
			"plan_review_feedback",
			"resolve_merge_conflict",
			"review_implementation",
			"review_plan",
			"simplification_decision",
			"simplify_implementation",
		]);
		expect(
			sorted(
				[...localRepoChangeProcess.turns]
					.filter(([, binding]) => binding.definition.kind === "human")
					.map(([turnId]) => turnId),
			),
		).toEqual([
			implementationDecision.id,
			implementationReviewFeedback.id,
			planDecision.id,
			planReviewFeedback.id,
			simplificationDecision.id,
		]);

		for (const spec of [
			{
				turnId: "generate_plan",
				consumedProducts: undefined,
				publishedProduct: "plan",
				transitions: [{ nextTurnId: "plan_decision", outcome: "plan_saved" }],
			},
			{
				turnId: "implement",
				consumedProducts: ["plan"],
				publishedProduct: "implementation-summary",
				transitions: [{ nextTurnId: "implementation_decision", outcome: "implementation-summary" }],
			},
			{
				turnId: "review_implementation",
				consumedProducts: undefined,
				publishedProduct: "review",
				transitions: [
					{ nextTurnId: "implementation_decision", outcome: "no_issues" },
					{ nextTurnId: "implementation_review_feedback", outcome: "request_changes" },
				],
			},
			{
				turnId: "simplify_implementation",
				consumedProducts: undefined,
				publishedProduct: "simplification-plan",
				transitions: [{ nextTurnId: "simplification_decision", outcome: "simplification-plan" }],
			},
			{
				turnId: "commit_and_merge",
				consumedProducts: undefined,
				publishedProduct: undefined,
				transitions: [
					{ nextTurnId: "resolve_merge_conflict", outcome: "merge_conflict" },
					{ lifecycleStatus: "completed", outcome: "finalized" },
				],
			},
		] as const) {
			const turn = graph.turns.get(spec.turnId);
			expect(turn?.consumedProducts).toEqual(spec.consumedProducts);
			expect(turn?.publishedProduct).toBe(spec.publishedProduct);
			expect(transitionsFor(spec.turnId)).toEqual(spec.transitions);
		}

		expect(localRepoChangeProcess.turns.get("implement")?.definition).toMatchObject({
			kind: "llm",
			branchType: "primary",
			context: "fresh_seeded",
			startFrom: {
				kind: "product_ref",
				productName: "simplification-plan",
				fallback: {
					kind: "semantic_ref",
					ref: "review",
					fallback: { kind: "session_root" },
				},
			},
		});
		expect(transitionsFor("simplification_decision")).toEqual([
			{ nextTurnId: "implement", trigger: "accept_review" },
			{ nextTurnId: "simplify_implementation", trigger: "request_review_changes" },
			{ nextTurnId: "implementation_decision", trigger: "dismiss_review" },
		]);

		for (const turnId of ["generate_plan", "review_plan", "review_implementation"]) {
			const definition = localRepoChangeProcess.turns.get(turnId)?.definition;
			expect(definition?.kind).toBe("llm");
			if (definition?.kind !== "llm") continue;
			for (const outcome of Object.values(definition.outcomes ?? {})) {
				expect(outcome.description).toContain("Mermaid diagrams or uploaded images");
			}
		}
	});

	it("keeps human-turn actions aligned with shared forms", () => {
		for (const [turnField, formField] of [
			[
				planDecision.notesFields?.find((field) => field.id === "message"),
				requestRevisionForm.fields.find((field) => field.id === "message"),
			],
			[
				planReviewFeedback.notesFields?.find((field) => field.id === "message"),
				requestReviewChangesForm.fields.find((field) => field.id === "message"),
			],
		] as const) {
			expect(turnField).toMatchObject({ required: true });
			expect(formField).toMatchObject({ required: true });
		}
		expect(
			simplificationDecision.notesFields?.find((field) => field.id === "message"),
		).toMatchObject({
			required: true,
		});
		expect(acceptReviewForm.fields.find((field) => field.id === "message")).toMatchObject({
			id: "message",
			kind: "textarea",
		});
		expect(finalizeChangeForm).toMatchObject({
			title: "Merge change",
			submitLabel: "Merge change",
			fields: [],
		});
		expect(
			resolveHumanTurnView({
				turnId: implementationDecision.id,
				turn: implementationDecision,
			}).actions.find((action) => action.actionId === localRepoChangeActionIds.finalizeChange),
		).toMatchObject({ label: "Merge change" });
	});

	it("resolves and validates launcher config", () => {
		const launcher = buildProcessLaunchersForTest(localRepoChangeProcess)?.launchers.get(
			"local_repo_change_process.ui_launcher",
		)?.ui;
		expect(launcher).toBeDefined();
		if (!launcher) return;

		expect(
			launcher.launchConfigSchema.fields.find((field) => field.id === "repoLocator"),
		).toMatchObject({ rememberRecentValues: true });

		expect(
			launcher.resolveLaunchConfig({
				repoLocator: "./repo",
				baseBranch: "main",
				workBranch: "feature/demo",
				prompt: "Update the CLI help output",
			}),
		).toMatchObject({
			ok: true,
			launchConfig: {
				startTurnId: "generate_plan",
				params: { launchKind: "requested_change" },
			},
		});
	});

	it("clears the work branch when preparing a relaunch", async () => {
		const launcher = buildProcessLaunchersForTest(localRepoChangeProcess)?.launchers.get(
			"local_repo_change_process.ui_launcher",
		)?.ui;
		expect(launcher?.resolveRelaunchInput).toBeDefined();
		await expect(
			Promise.resolve(
				launcher?.resolveRelaunchInput?.(
					{
						repoLocator: "./repo",
						baseBranch: "main",
						workBranch: "dirty-old-branch",
						prompt: "Update the CLI help output",
					},
					{},
				),
			),
		).resolves.toEqual({
			repoLocator: "./repo",
			baseBranch: "main",
			workBranch: "",
			prompt: "Update the CLI help output",
		});
	});

	it("queues targeted operator input for revision and review actions", async () => {
		const definition = buildServerProcessForTest(localRepoChangeProcess);
		for (const spec of [
			{
				actionId: localRepoChangeActionIds.requestRevision,
				selectedTurnId: implementationDecision.id,
				message: "Please tighten the implementation.",
				expectedTurnId: "implement",
				expectedTrigger: "request_revision",
				expectedTarget: { semanticRef: "currentPrimaryPathLeaf" },
			},
			{
				actionId: localRepoChangeActionIds.requestReviewChanges,
				selectedTurnId: implementationReviewFeedback.id,
				message: "Focus on the rollout risk.",
				expectedTurnId: "review_implementation",
				expectedTrigger: "request_review_changes",
				expectedTarget: { semanticRef: "review" },
			},
		] as const) {
			const action = definition?.actions.get(spec.actionId);
			expect(action).toBeDefined();
			if (!action) continue;

			const transitions: Array<Record<string, unknown>> = [];
			const queued: Array<Record<string, unknown>> = [];
			await invokeAction(
				action,
				{ message: spec.message },
				testContext({
					selectedTurnId: spec.selectedTurnId,
					transition: (next) => transitions.push(next as Record<string, unknown>),
					queueInput: (input) => queued.push(input as Record<string, unknown>),
				}),
			);

			expect(transitions).toEqual([
				expect.objectContaining({ turnId: spec.expectedTurnId, trigger: spec.expectedTrigger }),
			]);
			expect(queued).toEqual([
				{
					source: "action_prompt",
					kind: "instruction",
					target: spec.expectedTarget,
					bodyMarkdown: spec.message,
				},
			]);
		}
	});

	it("accepts review products by queueing markdown without duplicating it into durable state", async () => {
		const definition = buildServerProcessForTest(localRepoChangeProcess);
		const action = definition?.actions.get(localRepoChangeActionIds.acceptReview);
		expect(action).toBeDefined();
		if (!action) return;

		const review = { entryId: "ent_review", turnRecordId: "trn_review" };
		const simplificationPlan = { entryId: "ent_simplify", turnRecordId: "trn_simplify" };
		for (const spec of [
			{
				selectedTurnId: planReviewFeedback.id,
				state: createState({
					semanticEntryRefs: { ...createEmptyStructuralProcessState().semanticEntryRefs, review },
				}),
				readSemanticTurnResultMarkdown: (ref: string) =>
					ref === "review" ? "## Review\n\nAdd a rollback step." : null,
				expectedTurnId: "generate_plan",
				expectedTarget: { semanticRef: "currentPrimaryPathLeaf" },
				expectedOpening: "Revise the plan according to this review:",
				expectedBody: "Add a rollback step.",
			},
			{
				selectedTurnId: implementationReviewFeedback.id,
				state: createState({
					semanticEntryRefs: { ...createEmptyStructuralProcessState().semanticEntryRefs, review },
				}),
				readSemanticTurnResultMarkdown: (ref: string) =>
					ref === "review" ? "## Review\n\nFix the error handling." : null,
				expectedTurnId: "implement",
				expectedTarget: { semanticRef: "review" },
				expectedOpening: "Implement according to this review:",
				expectedBody: "Fix the error handling.",
			},
			{
				selectedTurnId: simplificationDecision.id,
				state: createState({
					productRefs: { "simplification-plan": simplificationPlan },
				}),
				readProductTurnResultMarkdown: (productName: string) =>
					productName === "simplification-plan"
						? "## Simplify\n\nInline the temporary helper."
						: null,
				expectedTurnId: "implement",
				expectedTarget: { productName: "simplification-plan" },
				expectedOpening: "Implement according to this simplification plan:",
				expectedBody: "Inline the temporary helper.",
			},
		] as const) {
			const transitions: Array<Record<string, unknown>> = [];
			const queued: Array<Record<string, unknown>> = [];
			await invokeAction(
				action,
				{ message: "Skip the legacy fallback." },
				testContext({
					selectedTurnId: spec.selectedTurnId,
					state: spec.state,
					transition: (next) => transitions.push(next as Record<string, unknown>),
					queueInput: (input) => queued.push(input as Record<string, unknown>),
					readSemanticTurnResultMarkdown: spec.readSemanticTurnResultMarkdown,
					readProductTurnResultMarkdown: spec.readProductTurnResultMarkdown,
				}),
			);

			expect(transitions[0]).toMatchObject({
				turnId: spec.expectedTurnId,
				trigger: "accept_review",
			});
			expect(queued[0]).toMatchObject({
				source: "action_prompt",
				kind: "instruction",
				target: spec.expectedTarget,
			});
			const bodyMarkdown = String(queued[0]?.bodyMarkdown ?? "");
			expect(bodyMarkdown).toMatch(new RegExp(`^${spec.expectedOpening}`));
			expect(bodyMarkdown).toContain(spec.expectedBody);
			expect(bodyMarkdown).toContain("Skip the legacy fallback.");
			expect(bodyMarkdown).not.toContain("accepted by the operator");
		}
	});

	it("records key turn outcomes as refs and finalization metadata", async () => {
		const definition = buildServerProcessForTest(localRepoChangeProcess);
		const state = createState({
			semanticEntryRefs: {
				...createEmptyStructuralProcessState().semanticEntryRefs,
				review: { entryId: "ent_old_review", turnRecordId: "trn_old_review" },
			},
		});

		const planTransitions: Array<Record<string, unknown>> = [];
		const lifecycleEffects: Array<Record<string, unknown>> = [];
		await definition?.turnOutcomeHandlers.get("generate_plan")?.[0]?.(
			{
				turnRecordId: "trn_plan_2",
				turnId: "generate_plan",
				outcome: "plan_saved",
				params: { summary: "Break the work into two steps", acceptanceCriteria: ["tests pass"] },
				turnResultMarkdown: "# Plan",
			},
			testContext({
				selectedTurnId: "generate_plan",
				lifecycleStatus: "active",
				state,
				transition: (next) => planTransitions.push(next as Record<string, unknown>),
				applyLifecycleEffects: (effects) =>
					lifecycleEffects.push(effects as Record<string, unknown>),
			}),
		);
		expect(planTransitions).toEqual([
			expect.objectContaining({
				state: expect.objectContaining({
					semanticEntryRefs: expect.objectContaining({ review: null }),
				}),
			}),
		]);
		expect(lifecycleEffects[0]).toMatchObject({ processPatch: { planRevision: 3 } });

		for (const spec of [
			{
				turnId: "review_plan",
				outcome: "request_changes",
				markdown: "## Review\n\nTighten the rollout steps.",
			},
			{
				turnId: "implement",
				outcome: "implementation-summary",
				markdown: "## Implementation\n\nChanged the sidebar.",
			},
			{
				turnId: "commit_and_merge",
				outcome: "finalized",
				params: { headSha: "def456", usedConflictResolution: true },
				markdown: "## Finalized\n\nPushed the merged HEAD.",
				expectedState: {
					finalization: resetLocalRepoChangeFinalizationState({
						usedConflictResolution: true,
						finalizationSummaryMarkdown: "## Finalized\n\nPushed the merged HEAD.",
						finalizedHeadSha: "def456",
					}),
				},
			},
		] as const) {
			const transitions: Array<Record<string, unknown>> = [];
			await definition?.turnOutcomeHandlers.get(spec.turnId)?.[0]?.(
				{
					turnRecordId: `trn_${spec.turnId}`,
					turnId: spec.turnId,
					outcome: spec.outcome,
					params: spec.params ?? {},
					turnResultMarkdown: spec.markdown ?? "",
				},
				testContext({
					selectedTurnId: spec.turnId,
					lifecycleStatus: "active",
					state: "state" in spec ? spec.state : undefined,
					transition: (next) => transitions.push(next as Record<string, unknown>),
				}),
			);
			if ("expectedState" in spec) {
				expect(transitions).toEqual([
					expect.objectContaining({ state: expect.objectContaining(spec.expectedState) }),
				]);
			}
		}
	});
});

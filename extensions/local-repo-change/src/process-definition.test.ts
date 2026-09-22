import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import { createEmptyStructuralProcessState } from "@leitwerk-dev/process-sdk";
import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
import { describe, expect, it, onTestFinished } from "vitest";
import { localRepoChangeActionIds } from "./actions.js";
import { localRepoChangeProcess } from "./process-definition.js";

const params = {
	launchKind: "requested_change" as const,
	repoLocator: "/tmp/repo",
	baseBranch: "main",
	workBranch: "feature/test",
	prompt: "Ship the requested change",
};
function createState(overrides: Partial<RepositoryChangeState> = {}) {
	return { ...localRepoChangeProcess.initialState(params), ...overrides };
}
async function harness() {
	const test = await createExtensionTestHarness();
	onTestFinished(() => test.close());
	return test.process(localRepoChangeProcess, { params, planRevision: 2 });
}
const launcherId = "local_repo_change_process.ui_launcher";

describe("localRepoChangeProcess", () => {
	it("describes the declared graph and published products", async () => {
		const process = await harness();
		const description = process.describe();
		expect(description.entryTurnIds).toEqual(["generate_plan", "import_plan"]);
		expect(description.turns.find((turn) => turn.id === "import_plan")?.kind).toBe("automatic");
		expect(description.turns.map((turn) => turn.id).sort()).toEqual([
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
			const turn = description.turns.find((turn) => turn.id === spec.turnId);
			expect(turn?.consumedProducts).toEqual(spec.consumedProducts);
			expect(turn?.publishedProduct).toBe(spec.publishedProduct);
			expect(
				description.transitions
					.filter((transition) => transition.from === spec.turnId)
					.map(({ from: _from, ...transition }) => transition),
			).toEqual(spec.transitions);
		}
	});
	it("exposes operator action forms", async () => {
		const description = (await harness()).describe();
		for (const id of [
			localRepoChangeActionIds.requestRevision,
			localRepoChangeActionIds.requestReviewChanges,
		])
			expect(
				description.actions
					.find((action) => action.id === id)
					?.form?.fields.find((field) => field.id === "message"),
			).toMatchObject({ required: true });
		expect(
			description.actions.find((action) => action.id === localRepoChangeActionIds.finalizeChange),
		).toMatchObject({
			label: "Merge change",
			form: { title: "Merge change", submitLabel: "Merge change", fields: [] },
		});
	});
	it("resolves launcher input and prepares a new work branch on relaunch", async () => {
		const process = await harness();
		expect(
			process
				.describe()
				.launchers[0]?.launchConfigSchema.fields.find((field) => field.id === "repoLocator"),
		).toMatchObject({ rememberRecentValues: true });
		const input = {
			repoLocator: "./repo",
			baseBranch: "main",
			workBranch: "feature/demo",
			prompt: "Update the CLI help output",
		};
		expect(await process.resolveLaunch(launcherId, input)).toMatchObject({
			ok: true,
			launchConfig: { startTurnId: "generate_plan", params: { launchKind: "requested_change" } },
		});
		expect(await process.prepareRelaunch(launcherId, input)).toEqual({ ...input, workBranch: "" });
	});
	it("queues targeted instructions for revision and review", async () => {
		const process = await harness();
		for (const spec of [
			{
				actionId: localRepoChangeActionIds.requestRevision,
				selectedTurnId: "implementation_decision",
				message: "Please tighten the implementation.",
				expectedTurnId: "implement",
				expectedTrigger: "request_revision",
				expectedTarget: { semanticRef: "currentPrimaryPathLeaf" },
			},
			{
				actionId: localRepoChangeActionIds.requestReviewChanges,
				selectedTurnId: "implementation_review_feedback",
				message: "Focus on the rollout risk.",
				expectedTurnId: "review_implementation",
				expectedTrigger: "request_review_changes",
				expectedTarget: { semanticRef: "review" },
			},
		] as const) {
			const result = await process.evaluateAction(
				spec.actionId,
				{ message: spec.message },
				{ position: { selectedTurnId: spec.selectedTurnId, lifecycleStatus: "waiting" } },
			);
			expect(result.transitions).toEqual([
				expect.objectContaining({ turnId: spec.expectedTurnId, trigger: spec.expectedTrigger }),
			]);
			expect(result.inputs).toEqual([
				{
					source: "action_prompt",
					kind: "instruction",
					target: spec.expectedTarget,
					bodyMarkdown: spec.message,
				},
			]);
		}
	});
	it("passes accepted review material as input without copying it into state", async () => {
		const process = await harness();
		for (const spec of [
			{
				turn: "plan_review_feedback",
				target: "generate_plan",
				product: "review",
				markdown: "Add a rollback step.",
				opening: "Revise the plan according to this review:",
				inputTarget: { semanticRef: "currentPrimaryPathLeaf" },
			},
			{
				turn: "implementation_review_feedback",
				target: "implement",
				product: "review",
				markdown: "Fix the error handling.",
				opening: "Implement according to this review:",
				inputTarget: { semanticRef: "review" },
			},
			{
				turn: "simplification_decision",
				target: "implement",
				product: "simplification-plan",
				markdown: "Inline the temporary helper.",
				opening: "Implement according to this simplification plan:",
				inputTarget: { productName: "simplification-plan" },
			},
		]) {
			const state = createState({
				semanticEntryRefs: {
					...createEmptyStructuralProcessState().semanticEntryRefs,
					review: { entryId: "ent_review", turnRecordId: "trn_review" },
				},
				productRefs: {
					"simplification-plan": { entryId: "ent_simplify", turnRecordId: "trn_simplify" },
				},
			});
			const result = await process.evaluateAction(
				localRepoChangeActionIds.acceptReview,
				{ message: "Skip the legacy fallback." },
				{
					state,
					position: { selectedTurnId: spec.turn, lifecycleStatus: "waiting" },
					products: { [spec.product]: spec.markdown },
				},
			);
			expect(result.transitions[0]).toMatchObject({
				turnId: spec.target,
				trigger: "accept_review",
			});
			expect(result.inputs[0]).toMatchObject({
				source: "action_prompt",
				kind: "instruction",
				target: spec.inputTarget,
			});
			expect(result.inputs[0]?.bodyMarkdown).toContain(spec.opening);
			expect(result.inputs[0]?.bodyMarkdown).toContain(spec.markdown);
			expect(result.inputs[0]?.bodyMarkdown).toContain("Skip the legacy fallback.");
			expect(result.inputs[0]?.bodyMarkdown).not.toContain("accepted by the operator");
		}
	});
	it("records plan revision effects and finalization metadata", async () => {
		const process = await harness();
		const state = createState({
			semanticEntryRefs: {
				...createEmptyStructuralProcessState().semanticEntryRefs,
				review: { entryId: "ent_old_review", turnRecordId: "trn_old_review" },
			},
		});
		const plan = await process.evaluateOutcome(
			"generate_plan",
			{
				outcome: "plan_saved",
				params: { summary: "Break work into two steps", acceptanceCriteria: ["tests pass"] },
				markdown: "# Plan",
			},
			{ state },
		);
		expect(plan.transitions).toEqual([
			expect.objectContaining({
				state: expect.objectContaining({
					semanticEntryRefs: expect.objectContaining({ review: null }),
				}),
			}),
		]);
		expect(plan.lifecycle[0]).toMatchObject({ processPatch: { planRevision: 3 } });
		const finalization = await process.evaluateOutcome(
			"commit_and_merge",
			{
				outcome: "finalized",
				params: { headSha: "def456", usedConflictResolution: true },
				markdown: "## Finalized\n\nPushed the merged HEAD.",
			},
			{ position: { selectedTurnId: "commit_and_merge", lifecycleStatus: "active" } },
		);
		expect(finalization.transitions).toEqual([
			expect.objectContaining({
				state: expect.objectContaining({
					finalization: expect.objectContaining({
						usedConflictResolution: true,
						finalizationSummaryMarkdown: "## Finalized\n\nPushed the merged HEAD.",
						finalizedHeadSha: "def456",
					}),
				}),
			}),
		]);
	});
});

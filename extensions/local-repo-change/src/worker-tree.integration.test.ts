import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RepositoryChangeState as LocalRepoChangeState } from "@leitwerk-dev/coding/repository-change-state";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import { createProjectFixture } from "@leitwerk-dev/test-support/fixtures";
import { createExtensionIntegrationHarness } from "@leitwerk-dev/test-support/integration";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { describe, expect, it, onTestFinished } from "vitest";
import { localRepoChangeActionIds } from "./actions.js";
import localRepoChangeExtension from "./index.js";
import type { LocalRepoChangeParams } from "./params.js";
import { localRepoChangeProcess } from "./process-definition.js";

const defaultParams: LocalRepoChangeParams = {
	launchKind: "requested_change",
	repoLocator: "https://example.com/local-repo.git",
	baseBranch: "main",
	workBranch: "feature/collapsible-sidebar",
	prompt: "Make the sidebar collapsible.",
};

const candidatePlanMarkdown = `# Candidate plan

1. Inspect the sidebar.
2. Add collapsed state.
3. Cover the behavior with tests.`;
const implementationMarkdown = `## Implementation

Added a collapsible sidebar and tests.`;
const planReviewMarkdown = `## Plan review

Looks ready.`;
const implementationReviewMarkdown = `## Implementation review

Looks ready.`;

async function createHarness(overrides: Partial<LocalRepoChangeParams> = {}) {
	const root = mkdtempSync(path.join(tmpdir(), "local-repo-tree-"));
	const git = new LocalGit(root);
	const baseBranch = overrides.baseBranch ?? "main";
	const { bare } = git.seed({
		owner: "test",
		name: "repo",
		defaultBranch: baseBranch,
		files: { "README.md": "# Sidebar\n" },
	});
	const params: LocalRepoChangeParams = { ...defaultParams, ...overrides, repoLocator: bare };
	const test = await createExtensionIntegrationHarness({
		extensions: [
			localRepoChangeExtension,
			{
				manifest: { id: "local-test-model", version: "1" },
				modelProviders: fixtureModelProviders({
					id: "local-test-model",
					modelId: "test-model",
					server: true,
				}),
			},
		],
		execution: "manual",
		models: [{ id: "scripted", provider: "local-test-model", modelId: "test-model" }],
		defaultModel: "scripted",
	});
	onTestFinished(async () => {
		try {
			await test.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	const process = await test.createProcess(localRepoChangeProcess, {
		params,
		projects: [
			createProjectFixture({
				key: "repo",
				repoLocator: bare,
				repoLocatorKind: "local_path",
				baseBranch,
				workBranch: params.workBranch,
			}),
		],
	});
	return { process, params, git, bare };
}
type Harness = Awaited<ReturnType<typeof createHarness>>;
function currentProcess(harness: Harness) {
	return harness.process.snapshot().process;
}
function currentState(harness: Harness) {
	return harness.process.snapshot().state as LocalRepoChangeState;
}
function executeAction(harness: Harness, id: string, input: Record<string, unknown> = {}) {
	return harness.process.action(id, input);
}
async function runSelectedTurn(
	harness: Harness,
	script: ReadonlyArray<{ toolName: string; args: Record<string, unknown> }>,
) {
	const result = await harness.process.runTurn({
		tools: script
			.filter((call) => call.toolName !== "markdown_result")
			.map((call) => ({ name: call.toolName, arguments: call.args })),
		markdown: script.find((call) => call.toolName === "markdown_result")?.args.markdown as
			| string
			| undefined,
	});
	if (!result.turn || result.turn.status !== "succeeded")
		throw new Error(`Turn failed: ${JSON.stringify(result)}`);
	return { ...result, turn: result.turn };
}

describe("local repo change instance tree", () => {
	it("accepts three plan reviews and enters the fourth planning pass at revision three", async () => {
		const harness = await createHarness();
		const savePlan = () =>
			runSelectedTurn(harness, [
				{
					toolName: "plan_saved",
					args: {
						markdown: candidatePlanMarkdown,
						summary: "Plan saved",
						acceptanceCriteria: ["Sidebar collapses"],
					},
				},
			]);
		await savePlan();
		for (let revision = 1; revision <= 3; revision++) {
			await executeAction(harness, localRepoChangeActionIds.runReview);
			await runSelectedTurn(harness, [
				{ toolName: "request_changes", args: { markdown: planReviewMarkdown } },
			]);
			expect(currentProcess(harness).selectedTurnId).toBe("plan_review_feedback");
			await executeAction(harness, localRepoChangeActionIds.acceptReview);
			expect(currentProcess(harness)).toMatchObject({
				selectedTurnId: "generate_plan",
				planRevision: revision,
			});
			await savePlan();
			expect(currentProcess(harness)).toMatchObject({
				selectedTurnId: "plan_decision",
				lifecycleStatus: "waiting",
				planRevision: revision + 1,
			});
		}
	}, 60000);

	it("runs one end-to-end happy path and preserves branch/ref semantics", async () => {
		const harness = await createHarness({ baseBranch: "release/2026.04" });

		const planRun = await runSelectedTurn(harness, [
			{ toolName: "markdown_result", args: { markdown: candidatePlanMarkdown } },
			{
				toolName: "plan_saved",
				args: {
					markdown: candidatePlanMarkdown,
					summary: "Plan saved",
					acceptanceCriteria: ["Sidebar collapses"],
				},
			},
		]);
		const afterPlanState = currentState(harness);
		expect(planRun.turn).toMatchObject({ pathType: "primary", forkPiEntryId: null });
		expect(currentProcess(harness)).toMatchObject({
			selectedTurnId: "plan_decision",
			lifecycleStatus: "waiting",
		});
		expect(afterPlanState).not.toHaveProperty("latestPlanMarkdown");
		expect(afterPlanState.semanticEntryRefs.plan?.entryId).toBe(planRun.turn.resultPiEntryId);
		const rootEntryId = afterPlanState.semanticEntryRefs.rootEntry?.entryId;
		expect(rootEntryId).toBeTruthy();

		await executeAction(harness, localRepoChangeActionIds.runReview);
		const planReviewRun = await runSelectedTurn(harness, [
			{ toolName: "markdown_result", args: { markdown: planReviewMarkdown } },
			{ toolName: "no_issues", args: { markdown: planReviewMarkdown } },
		]);
		expect(planReviewRun.turn).toMatchObject({ pathType: "root_branch", forkPiEntryId: null });
		expect(currentProcess(harness).selectedTurnId).toBe("plan_decision");
		expect(currentState(harness).semanticEntryRefs.currentPrimaryPathLeaf?.entryId).toBe(
			planRun.turn.resultPiEntryId,
		);
		expect(currentState(harness).semanticEntryRefs.review?.entryId).toBe(
			planReviewRun.turn.resultPiEntryId,
		);

		await executeAction(harness, localRepoChangeActionIds.approvePlan);
		const implementRun = await runSelectedTurn(harness, [
			{ toolName: "markdown_result", args: { markdown: implementationMarkdown } },
		]);
		expect(implementRun.turn).toMatchObject({ pathType: "primary", forkPiEntryId: null });
		expect(currentProcess(harness)).toMatchObject({
			selectedTurnId: "implementation_decision",
			lifecycleStatus: "waiting",
		});
		expect(currentState(harness)).not.toHaveProperty("latestImplementationMarkdown");
		expect(currentState(harness).semanticEntryRefs.currentPrimaryPathLeaf?.entryId).toBe(
			implementRun.turn.resultPiEntryId,
		);

		await executeAction(harness, localRepoChangeActionIds.runReview);
		const implementationReviewRun = await runSelectedTurn(harness, [
			{ toolName: "markdown_result", args: { markdown: implementationReviewMarkdown } },
			{ toolName: "no_issues", args: { markdown: implementationReviewMarkdown } },
		]);
		expect(implementationReviewRun.turn).toMatchObject({
			pathType: "root_branch",
			forkPiEntryId: null,
		});
		expect(currentProcess(harness).selectedTurnId).toBe("implementation_decision");

		await executeAction(harness, localRepoChangeActionIds.finalizeChange);
		const commitMessageRun = await runSelectedTurn(harness, [
			{ toolName: "markdown_result", args: { markdown: "Implement the accepted plan" } },
		]);
		expect(currentState(harness).finalization.generatedCommitMessage).toBe(
			"Implement the accepted plan",
		);
		expect(currentProcess(harness).selectedTurnId).toBe("commit_and_merge");
		const finalized = await harness.process.runTurn();
		expect(finalized.turn).toMatchObject({ turnId: "commit_and_merge", status: "succeeded" });

		expect(currentProcess(harness)).toMatchObject({
			selectedTurnId: null,
			lifecycleStatus: "completed",
		});
		expect(currentState(harness).finalization.finalizationSummaryMarkdown).toBe(
			finalized.turn?.turnResultMarkdown,
		);
		expect(
			harness.git.run(harness.bare, ["rev-parse", `refs/heads/${harness.params.baseBranch}`]),
		).toBeTruthy();

		expect(planReviewRun.prompts?.[0] ?? "").toContain(defaultParams.prompt);
		expect(planReviewRun.prompts?.[0] ?? "").toContain(candidatePlanMarkdown);
		expect(implementRun.prompts?.[0] ?? "").toContain(candidatePlanMarkdown);
		expect(implementationReviewRun.prompts?.[0] ?? "").toContain("release/2026.04");
		expect(implementationReviewRun.prompts?.[0] ?? "").toContain(defaultParams.prompt);
		expect(implementationReviewRun.prompts?.[0] ?? "").not.toContain(candidatePlanMarkdown);

		if (
			!rootEntryId ||
			!planReviewRun.turn.resultPiEntryId ||
			!implementRun.turn.resultPiEntryId ||
			!implementationReviewRun.turn.resultPiEntryId ||
			!commitMessageRun.turn.resultPiEntryId
		) {
			throw new Error("Expected root and result entry ids to be populated");
		}
		expect(currentState(harness).semanticEntryRefs.currentPrimaryPathLeaf?.entryId).toBe(
			implementRun.turn.resultPiEntryId,
		);
		const resultRefs = [
			planRun,
			planReviewRun,
			implementRun,
			implementationReviewRun,
			commitMessageRun,
		].map((run) => run.turn.resultPiEntryId);
		expect(new Set(resultRefs).size).toBe(resultRefs.length);
		const persisted = harness.process.snapshot().turns;
		for (const run of [
			planRun,
			planReviewRun,
			implementRun,
			implementationReviewRun,
			commitMessageRun,
		])
			expect(persisted.find((turn) => turn.id === run.turn.id)?.resultPiEntryId).toBe(
				run.turn.resultPiEntryId,
			);
	}, 60000);
});

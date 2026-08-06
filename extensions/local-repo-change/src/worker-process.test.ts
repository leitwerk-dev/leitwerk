import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RepositoryChangeState as LocalRepoChangeState } from "@leitwerk-dev/coding/repository-change-state";
import { buildImplementPrompt } from "@leitwerk-dev/coding/turns/implement";
import { buildReviewImplementationPrompt } from "@leitwerk-dev/coding/turns/review-implementation";
import {
	createTestProcessInstance,
	createTestProcessProject,
	createTestWorkerProcessContext,
	runWorkerProcessTurnForTest,
} from "@leitwerk-dev/extension-runtime/testing";
import {
	createEmptyStructuralProcessState,
	createFlowPromptContext,
} from "@leitwerk-dev/process-sdk";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localRepoChangeProcess } from "./process-definition.js";

// Real subprocesses (git, worker turns) make these cases slow under the full
// parallel suite; raise the timeout so spawn contention does not flake them.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

function createPromptContext(input: {
	projects?: ReturnType<typeof createTestProcessProject>[];
	params?: Record<string, unknown>;
	state?: LocalRepoChangeState;
	turnResultMarkdownByProduct?: Record<string, string>;
}) {
	return createTestWorkerProcessContext({
		process: createTestProcessInstance({ processId: localRepoChangeProcess.id }),
		projects: input.projects,
		params: input.params,
		state: input.state,
		turnResultMarkdownByProduct: input.turnResultMarkdownByProduct,
	});
}

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync(resolveGitBinary(), args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function createBareRemote(): string {
	const remoteDir = createTempDir("local-repo-change-worker-remote");
	git(remoteDir, "init", "--bare");
	return remoteDir;
}

function createCleanWorkspaceRepo(): string {
	const workspaceRoot = createTempDir("local-repo-change-worker");
	const remoteDir = createBareRemote();
	const seedDir = createTempDir("local-repo-change-worker-seed");
	git(seedDir, "clone", remoteDir, ".");
	git(seedDir, "config", "user.email", "test@example.com");
	git(seedDir, "config", "user.name", "Test User");
	writeFileSync(path.join(seedDir, "README.md"), "# Example\n", "utf8");
	git(seedDir, "add", "README.md");
	git(seedDir, "commit", "-m", "initial");
	git(seedDir, "branch", "-M", "main");
	git(seedDir, "push", "origin", "main");

	const repoDir = path.join(workspaceRoot, "repo");
	git(workspaceRoot, "clone", remoteDir, "repo");
	git(repoDir, "config", "user.email", "test@example.com");
	git(repoDir, "config", "user.name", "Test User");
	git(repoDir, "checkout", "-b", "feature/test", "origin/main");
	return workspaceRoot;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("localRepoChangeProcess worker turns", () => {
	it("starts a fresh plan review from the root entry with bash-enabled inspection tools", async () => {
		let capturedTurn: Record<string, unknown> | null = null;
		await runWorkerProcessTurnForTest(localRepoChangeProcess, "review_plan", {
			params: {
				repoLocator: "/tmp/repo",
				baseBranch: "main",
				workBranch: "feature/test",
				prompt: "Ship the requested change",
			},
			turnResultMarkdownByProduct: {
				plan: "## Candidate plan\n\nShip it.",
			},
			state: createState({
				reviewSubject: { kind: "plan" },
				semanticEntryRefs: {
					...createEmptyStructuralProcessState().semanticEntryRefs,
					rootEntry: { entryId: "ent_root", turnRecordId: null },
					plan: { entryId: "ent_plan", turnRecordId: "trn_plan" },
				},
			}),
			turn(_turnId, def) {
				capturedTurn = def as unknown as Record<string, unknown>;
				return { outcome: "no_issues", params: {} };
			},
		});

		expect(capturedTurn).toMatchObject({
			branchType: "root_branch",
			context: "full",
			startFrom: {
				kind: "semantic_ref",
				ref: "review",
				fallback: { kind: "session_root" },
			},
		});
		expect((capturedTurn as { availableTools?: unknown } | null)?.availableTools).toEqual([
			"read",
			"bash",
		]);
	});

	it("starts plan review from the latest review branch when a review semantic ref exists", async () => {
		let capturedTurn: Record<string, unknown> | null = null;
		await runWorkerProcessTurnForTest(localRepoChangeProcess, "review_plan", {
			params: {
				repoLocator: "/tmp/repo",
				baseBranch: "main",
				workBranch: "feature/test",
				prompt: "Ship the requested change",
			},
			turnResultMarkdownByProduct: {
				plan: "## Candidate plan\n\nShip it.",
			},
			state: createState({
				reviewSubject: { kind: "plan" },
				semanticEntryRefs: {
					...createEmptyStructuralProcessState().semanticEntryRefs,
					plan: { entryId: "ent_plan", turnRecordId: "trn_plan" },
					review: { entryId: "ent_review", turnRecordId: "trn_review" },
				},
			}),
			turn(_turnId, def) {
				capturedTurn = def as unknown as Record<string, unknown>;
				return { outcome: "no_issues", params: {} };
			},
		});

		expect(capturedTurn).toMatchObject({
			startFrom: {
				kind: "semantic_ref",
				ref: "review",
				fallback: { kind: "session_root" },
			},
		});
	});

	it("uses workspace clone paths in repository prompts instead of the launch repo locator", async () => {
		const params = {
			repoLocator: "/tmp/original-repo",
			baseBranch: "main",
			workBranch: "feature/test",
			prompt: "Ship the requested change",
		};
		const projects = [
			createTestProcessProject({
				key: "repo",
				repoLocator: params.repoLocator,
				repoLocatorKind: "local_path",
				baseBranch: params.baseBranch,
				workBranch: params.workBranch,
			}),
		];
		const promptContext = createPromptContext({
			projects,
			params,
			state: createState(),
		});
		let generatePlanPrompt = "";
		let implementPrompt = "";
		let reviewImplementationPrompt = "";

		await runWorkerProcessTurnForTest(localRepoChangeProcess, "generate_plan", {
			params,
			projects,
			state: createState(),
			async turn(_turnId, def) {
				generatePlanPrompt = await def.prompt(promptContext);
				return {
					outcome: "plan_saved",
					params: { summary: "Plan saved", acceptanceCriteria: ["Done"] },
				};
			},
		});
		const promptContextWithPlan = createPromptContext({
			projects,
			params,
			state: createState(),
			turnResultMarkdownByProduct: { plan: "## Plan\n\nImplement it." },
		});
		implementPrompt = buildImplementPrompt(
			createFlowPromptContext(promptContextWithPlan, ["plan"]),
		);
		reviewImplementationPrompt = buildReviewImplementationPrompt(
			createFlowPromptContext(promptContextWithPlan, ["plan"]),
		);
		for (const prompt of [generatePlanPrompt, implementPrompt, reviewImplementationPrompt]) {
			expect(prompt).toContain("current working directory");
			expect(prompt).not.toContain(params.repoLocator);
			expect(prompt).not.toContain("./repo");
		}
	});

	it("uses runtime inputs in implementation review prompts", async () => {
		const params = {
			repoLocator: "/tmp/original-repo",
			baseBranch: "main",
			workBranch: "feature/test",
			prompt: "SENTINEL_REQUESTED_CHANGE",
		};
		const projects = [
			createTestProcessProject({
				key: "repo",
				repoLocator: params.repoLocator,
				repoLocatorKind: "local_path",
				baseBranch: "sentinel-review-base",
				workBranch: params.workBranch,
			}),
		];
		const promptContext = createPromptContext({
			projects,
			params,
			turnResultMarkdownByProduct: { plan: "SENTINEL_PLAN_MUST_NOT_BE_INCLUDED" },
			state: createState({
				reviewSubject: { kind: "implementation" },
				semanticEntryRefs: {
					...createEmptyStructuralProcessState().semanticEntryRefs,
					rootEntry: { entryId: "ent_root", turnRecordId: null },
					plan: { entryId: "ent_plan", turnRecordId: "trn_plan" },
				},
			}),
		});
		let reviewPrompt = "";
		let reviewTurn: Record<string, unknown> | null = null;

		await runWorkerProcessTurnForTest(localRepoChangeProcess, "review_implementation", {
			params,
			projects,
			turnResultMarkdownByProduct: {
				plan: "SENTINEL_PLAN_MUST_NOT_BE_INCLUDED",
			},
			state: createState({
				reviewSubject: { kind: "implementation" },
				semanticEntryRefs: {
					...createEmptyStructuralProcessState().semanticEntryRefs,
					rootEntry: { entryId: "ent_root", turnRecordId: null },
					plan: { entryId: "ent_plan", turnRecordId: "trn_plan" },
				},
			}),
			async turn(_turnId, def) {
				reviewTurn = def as unknown as Record<string, unknown>;
				reviewPrompt = await def.prompt(promptContext);
				return { outcome: "no_issues", params: {} };
			},
		});

		expect(reviewPrompt).toContain("sentinel-review-base");
		expect(reviewPrompt).toContain(params.prompt);
		expect(reviewPrompt).not.toContain("SENTINEL_PLAN_MUST_NOT_BE_INCLUDED");
		expect((reviewTurn as { availableTools?: unknown } | null)?.availableTools).toEqual([
			"read",
			"bash",
		]);
	});

	it("declares implement with the coding tool set and finalizes clean repos with the persisted message", async () => {
		let implementTurn: Record<string, unknown> | null = null;

		await runWorkerProcessTurnForTest(localRepoChangeProcess, "implement", {
			params: {
				repoLocator: "/tmp/repo",
				baseBranch: "main",
				workBranch: "feature/test",
				prompt: "Ship the requested change",
			},
			turnResultMarkdownByProduct: {
				plan: "## Plan\n\nImplement it.",
			},
			state: createState(),
			turn(_turnId, def) {
				implementTurn = def as unknown as Record<string, unknown>;
				return { outcome: "implementation-summary", params: {} };
			},
		});

		const workspaceRoot = createCleanWorkspaceRepo();
		const result = await runWorkerProcessTurnForTest(localRepoChangeProcess, "commit_and_merge", {
			projects: [
				createTestProcessProject({
					key: "repo",
					repoLocator: "/tmp/repo",
					repoLocatorKind: "local_path",
					baseBranch: "main",
					workBranch: "feature/test",
				}),
			],
			params: {
				repoLocator: "/tmp/repo",
				baseBranch: "main",
				workBranch: "feature/test",
				prompt: "Ship the requested change",
			},
			workspaceRoot,
			state: createState({
				finalization: {
					...createState().finalization,
					generatedCommitMessage: "Implement the accepted plan",
				},
			}),
		});

		expect(result.turnCalls).toEqual([]);
		expect(result.completed).toEqual([
			expect.objectContaining({
				outcome: "finalized",
				params: expect.objectContaining({ pushTarget: "origin/main" }),
			}),
		]);

		expect(implementTurn).toMatchObject({
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
		expect((implementTurn as { availableTools?: unknown } | null)?.availableTools).toEqual([
			"read",
			"bash",
			"edit",
			"write",
		]);
	}, 60_000);
});

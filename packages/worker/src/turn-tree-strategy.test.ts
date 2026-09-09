import {
	createRootBranchReviewTurn,
	type LlmTurnDefinition,
	type PiTreeEntry,
	type PiTreeNode,
} from "@leitwerk-dev/process-sdk";
import { StubPiTreeHandle } from "@leitwerk-dev/test-support/worker-testing";
import { describe, expect, it, vi } from "vitest";
import {
	planTurnTreeExecution,
	positionHandleForTurn,
	resolveRootEntryId,
	resolveRootEntryIdFromHandle,
	restoreHandleAfterTurn,
} from "./turn-tree-strategy.js";

function messageEntry(id: string, parentId: string | null): PiTreeEntry {
	return {
		id,
		parentId,
		type: "message",
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: id.startsWith("user-") ? "user" : "assistant",
			content: id,
		},
	};
}

function rootNode(entry: PiTreeEntry, children: PiTreeNode[] = []): PiTreeNode {
	return { entry, children };
}

function llmTurn(
	overrides: Partial<
		Pick<
			LlmTurnDefinition<string>,
			"branchType" | "context" | "startFrom" | "restorePrimaryLeafAfterTurn"
		>
	> = {},
): Pick<
	LlmTurnDefinition<string>,
	"branchType" | "context" | "startFrom" | "restorePrimaryLeafAfterTurn"
> {
	return {
		branchType: "primary",
		context: "full",
		...overrides,
	};
}

const rootBranchReviewTurn = createRootBranchReviewTurn({
	description: "Review implementation on a root branch",
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

const basePlan = {
	pathType: "primary" as const,
	forkPiEntryId: null,
	savedPrimaryLeafId: null,
	restorePrimaryLeafAfterTurn: false,
	startTarget: { kind: "current_leaf" as const },
};

describe("resolveRootEntryId", () => {
	it("prefers the first entry on the current branch", () => {
		const root = messageEntry("user-1", null);
		const child = messageEntry("turn-1", "user-1");
		const reviewUser = messageEntry("user-2", "user-1");
		const reviewTurn = messageEntry("turn-2", "user-2");

		expect(
			resolveRootEntryId({
				currentBranch: [root, reviewUser, reviewTurn],
				topLevelNodes: [
					rootNode(root, [rootNode(child), rootNode(reviewUser, [rootNode(reviewTurn)])]),
				],
			}),
		).toBe("user-1");
	});

	it("falls back to the first top-level entry when no current leaf is active", () => {
		const root = messageEntry("user-1", null);
		const secondRoot = messageEntry("user-2", null);

		expect(
			resolveRootEntryId({
				currentBranch: [],
				topLevelNodes: [rootNode(root), rootNode(secondRoot)],
			}),
		).toBe("user-1");
	});
});

describe("resolveRootEntryIdFromHandle", () => {
	it("resolves root from a handle with an active branch", async () => {
		const piHandle = new StubPiTreeHandle({
			sessionId: "stub-root-wrapper",
			treeFile: "/tmp/root-wrapper.jsonl",
			isResumed: false,
		});

		await piHandle.prompt("seed");

		expect(resolveRootEntryIdFromHandle(piHandle)).toBe("user-1");
	});

	it("returns null from an empty handle", () => {
		const piHandle = new StubPiTreeHandle({
			sessionId: "stub-root-empty",
			treeFile: "/tmp/root-empty.jsonl",
			isResumed: false,
		});

		expect(resolveRootEntryIdFromHandle(piHandle)).toBeNull();
	});
});

describe("planTurnTreeExecution", () => {
	it("keeps full primary-path turns at the current leaf", () => {
		expect(
			planTurnTreeExecution({
				turnDef: llmTurn(),
				currentLeafId: "turn-1",
				rootEntryId: "user-1",
			}),
		).toEqual({
			pathType: "primary",
			forkPiEntryId: "turn-1",
			savedPrimaryLeafId: "turn-1",
			restorePrimaryLeafAfterTurn: false,
			startTarget: { kind: "current_leaf" },
		});
	});

	it("starts review turns from the session root and restores the primary leaf", () => {
		expect(
			planTurnTreeExecution({
				turnDef: rootBranchReviewTurn,
				currentLeafId: "turn-1",
				rootEntryId: "user-1",
			}),
		).toEqual({
			pathType: "root_branch",
			forkPiEntryId: null,
			savedPrimaryLeafId: "turn-1",
			restorePrimaryLeafAfterTurn: true,
			startTarget: { kind: "root" },
		});
	});

	it("keeps leaf-branch turns on the current leaf but restores the primary leaf afterward", () => {
		expect(
			planTurnTreeExecution({
				turnDef: llmTurn({ branchType: "leaf_branch" }),
				currentLeafId: "turn-1",
				rootEntryId: "user-1",
			}),
		).toEqual({
			pathType: "leaf_branch",
			forkPiEntryId: "turn-1",
			savedPrimaryLeafId: "turn-1",
			restorePrimaryLeafAfterTurn: true,
			startTarget: { kind: "current_leaf" },
		});
	});

	it("falls back to the tree root when the root review branch has no resolved root entry yet", () => {
		expect(
			planTurnTreeExecution({
				turnDef: rootBranchReviewTurn,
				currentLeafId: null,
				rootEntryId: null,
			}),
		).toEqual({
			pathType: "root_branch",
			forkPiEntryId: null,
			savedPrimaryLeafId: null,
			restorePrimaryLeafAfterTurn: true,
			startTarget: { kind: "root" },
		});
	});

	it("falls back to the tree root when the persisted root entry is stale", () => {
		expect(
			planTurnTreeExecution({
				turnDef: rootBranchReviewTurn,
				currentLeafId: "turn-1",
				rootEntryId: "missing-root",
				entryExists: (entryId) => entryId === "turn-1",
			}),
		).toEqual({
			pathType: "root_branch",
			forkPiEntryId: null,
			savedPrimaryLeafId: "turn-1",
			restorePrimaryLeafAfterTurn: true,
			startTarget: { kind: "root" },
		});
	});

	it("resolves semantic-ref turn starts from process state when present", () => {
		expect(
			planTurnTreeExecution({
				turnDef: llmTurn({
					branchType: "primary",
					startFrom: { kind: "semantic_ref", ref: "plan" },
				}),
				currentLeafId: "turn-9",
				rootEntryId: "user-1",
				semanticEntryRefs: {
					plan: { entryId: "turn-3", turnRecordId: "trn_3" },
					review: null,
					currentPrimaryPathLeaf: null,
					rootEntry: null,
				},
			}),
		).toEqual({
			pathType: "primary",
			forkPiEntryId: "turn-3",
			savedPrimaryLeafId: "turn-9",
			restorePrimaryLeafAfterTurn: false,
			startTarget: { kind: "entry", entryId: "turn-3" },
		});
	});

	it("resolves product-ref turn starts from process state when present", () => {
		expect(
			planTurnTreeExecution({
				turnDef: llmTurn({
					branchType: "primary",
					startFrom: { kind: "product_ref", productName: "simplification-plan" },
				}),
				currentLeafId: "turn-9",
				rootEntryId: "user-1",
				productRefs: {
					"simplification-plan": { entryId: "turn-4", turnRecordId: "trn_4" },
				},
			}),
		).toEqual({
			pathType: "primary",
			forkPiEntryId: "turn-4",
			savedPrimaryLeafId: "turn-9",
			restorePrimaryLeafAfterTurn: false,
			startTarget: { kind: "entry", entryId: "turn-4" },
		});
	});

	it("starts fresh primary turns from the session root unless targeted input must be applied", () => {
		expect(
			planTurnTreeExecution({
				turnDef: llmTurn({ context: "fresh" }),
				currentLeafId: "turn-9",
				rootEntryId: "user-1",
			}),
		).toEqual({
			pathType: "primary",
			forkPiEntryId: null,
			savedPrimaryLeafId: "turn-9",
			restorePrimaryLeafAfterTurn: false,
			startTarget: { kind: "root" },
		});

		expect(
			planTurnTreeExecution({
				turnDef: llmTurn({ context: "fresh" }),
				currentLeafId: "turn-9",
				rootEntryId: "user-1",
				hasPreTurnTargetedInputs: true,
			}),
		).toEqual({
			pathType: "primary",
			forkPiEntryId: "turn-9",
			savedPrimaryLeafId: "turn-9",
			restorePrimaryLeafAfterTurn: false,
			startTarget: { kind: "current_leaf" },
		});
	});

	it("uses explicit seeds for fresh-seeded turns and falls back to the root", () => {
		expect(
			planTurnTreeExecution({
				turnDef: llmTurn({
					context: "fresh_seeded",
					startFrom: {
						kind: "product_ref",
						productName: "simplification-plan",
						fallback: { kind: "session_root" },
					},
				}),
				currentLeafId: "turn-9",
				rootEntryId: "user-1",
				productRefs: {
					"simplification-plan": { entryId: "turn-4", turnRecordId: "trn_4" },
				},
			}),
		).toEqual({
			pathType: "primary",
			forkPiEntryId: "turn-4",
			savedPrimaryLeafId: "turn-9",
			restorePrimaryLeafAfterTurn: false,
			startTarget: { kind: "entry", entryId: "turn-4" },
		});

		expect(
			planTurnTreeExecution({
				turnDef: llmTurn({
					context: "fresh_seeded",
					startFrom: {
						kind: "product_ref",
						productName: "simplification-plan",
						fallback: { kind: "session_root" },
					},
				}),
				currentLeafId: "turn-9",
				rootEntryId: "user-1",
				productRefs: {},
			}),
		).toEqual({
			pathType: "primary",
			forkPiEntryId: null,
			savedPrimaryLeafId: "turn-9",
			restorePrimaryLeafAfterTurn: false,
			startTarget: { kind: "root" },
		});

		expect(
			planTurnTreeExecution({
				turnDef: llmTurn({
					context: "fresh_seeded",
					startFrom: {
						kind: "product_ref",
						productName: "simplification-plan",
						fallback: { kind: "session_root" },
					},
				}),
				currentLeafId: "turn-9",
				rootEntryId: "user-1",
				semanticEntryRefs: {
					plan: null,
					review: null,
					currentPrimaryPathLeaf: { entryId: "turn-9", turnRecordId: "trn_9" },
					rootEntry: { entryId: "user-1", turnRecordId: null },
				},
				productRefs: {},
				preTurnStartSelection: { kind: "semantic_ref", ref: "currentPrimaryPathLeaf" },
				hasPreTurnTargetedInputs: true,
			}),
		).toEqual({
			pathType: "primary",
			forkPiEntryId: "turn-9",
			savedPrimaryLeafId: "turn-9",
			restorePrimaryLeafAfterTurn: false,
			startTarget: { kind: "entry", entryId: "turn-9" },
		});
	});

	it("retains compatibility fallback from a stale rootEntry ref to the branch's first entry", () => {
		expect(
			planTurnTreeExecution({
				turnDef: llmTurn({
					branchType: "primary",
					startFrom: {
						kind: "semantic_ref",
						ref: "rootEntry",
						fallback: { kind: "session_root" },
					},
				}),
				currentLeafId: "turn-9",
				rootEntryId: "user-1",
				semanticEntryRefs: {
					plan: null,
					review: null,
					currentPrimaryPathLeaf: null,
					rootEntry: { entryId: "missing-root", turnRecordId: null },
				},
				entryExists: (entryId) => entryId === "user-1" || entryId === "turn-9",
			}),
		).toEqual({
			pathType: "primary",
			forkPiEntryId: "user-1",
			savedPrimaryLeafId: "turn-9",
			restorePrimaryLeafAfterTurn: false,
			startTarget: { kind: "entry", entryId: "user-1" },
		});
	});
});

describe("positionHandleForTurn", () => {
	it("does nothing for current_leaf start target", async () => {
		const piHandle = { branch: vi.fn(), branchFromRoot: vi.fn() };

		await positionHandleForTurn(piHandle, {
			...basePlan,
			startTarget: { kind: "current_leaf" },
		});

		expect(piHandle.branch).not.toHaveBeenCalled();
		expect(piHandle.branchFromRoot).not.toHaveBeenCalled();
	});

	it("branches to the specified entry for entry start target", async () => {
		const piHandle = { branch: vi.fn(), branchFromRoot: vi.fn() };

		await positionHandleForTurn(piHandle, {
			...basePlan,
			startTarget: { kind: "entry", entryId: "user-1" },
		});

		expect(piHandle.branch).toHaveBeenCalledWith("user-1");
		expect(piHandle.branchFromRoot).not.toHaveBeenCalled();
	});

	it("resets to root for root start target", async () => {
		const piHandle = { branch: vi.fn(), branchFromRoot: vi.fn() };

		await positionHandleForTurn(piHandle, {
			...basePlan,
			startTarget: { kind: "root" },
		});

		expect(piHandle.branch).not.toHaveBeenCalled();
		expect(piHandle.branchFromRoot).toHaveBeenCalled();
	});
});

describe("restoreHandleAfterTurn", () => {
	it("does nothing when restorePrimaryLeafAfterTurn is false", async () => {
		const piHandle = { branch: vi.fn(), branchFromRoot: vi.fn() };

		await restoreHandleAfterTurn(piHandle, {
			...basePlan,
			restorePrimaryLeafAfterTurn: false,
		});

		expect(piHandle.branch).not.toHaveBeenCalled();
		expect(piHandle.branchFromRoot).not.toHaveBeenCalled();
	});

	it("branches to savedPrimaryLeafId when present", async () => {
		const piHandle = { branch: vi.fn(), branchFromRoot: vi.fn() };

		await restoreHandleAfterTurn(piHandle, {
			...basePlan,
			restorePrimaryLeafAfterTurn: true,
			savedPrimaryLeafId: "turn-1",
		});

		expect(piHandle.branch).toHaveBeenCalledWith("turn-1");
		expect(piHandle.branchFromRoot).not.toHaveBeenCalled();
	});

	it("falls back to branchFromRoot when savedPrimaryLeafId is null", async () => {
		const piHandle = { branch: vi.fn(), branchFromRoot: vi.fn() };

		await restoreHandleAfterTurn(piHandle, {
			...basePlan,
			restorePrimaryLeafAfterTurn: true,
			savedPrimaryLeafId: null,
		});

		expect(piHandle.branch).not.toHaveBeenCalled();
		expect(piHandle.branchFromRoot).toHaveBeenCalled();
	});
});

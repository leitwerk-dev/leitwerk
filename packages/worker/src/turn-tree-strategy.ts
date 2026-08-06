import {
	type ProcessProductRefs,
	type ProcessSemanticEntryRefs,
	type ProcessTurnRecordPathType,
	type ProcessTurnStartSelection,
	type ProcessTurnStartTarget,
	resolveProcessTurnStartSelection,
	resolveProcessTurnStartTarget,
} from "@leitwerk-dev/domain";
import {
	type LlmTurnDefinition,
	type PiTreeEntry,
	type PiTreeNode,
	resolveLlmTurnRestorePrimaryLeafAfterTurn,
} from "@leitwerk-dev/process-sdk";
import type { PiTreeHandle } from "./pi-adapter.js";

export interface TurnTreePlan {
	pathType: ProcessTurnRecordPathType;
	forkPiEntryId: string | null;
	savedPrimaryLeafId: string | null;
	restorePrimaryLeafAfterTurn: boolean;
	startTarget: ProcessTurnStartTarget;
}

export function resolveRootEntryId(input: {
	currentLeafId: string | null;
	currentBranch: readonly Pick<PiTreeEntry, "id">[];
	topLevelNodes: readonly Pick<PiTreeNode, "entry">[];
}): string | null {
	if (input.currentBranch.length > 0) {
		return input.currentBranch[0]?.id ?? null;
	}

	return input.topLevelNodes[0]?.entry.id ?? null;
}

export function resolveRootEntryIdFromHandle(
	piHandle: Pick<PiTreeHandle, "getLeafId" | "getBranch" | "getTree">,
): string | null {
	const currentLeafId = piHandle.getLeafId();
	const currentBranch = piHandle.getBranch(currentLeafId ?? undefined);
	const topLevelNodes = piHandle.getTree();
	return resolveRootEntryId({ currentLeafId, currentBranch, topLevelNodes });
}

function resolveContextAwareTurnStartSelection(input: {
	turnDef: Pick<LlmTurnDefinition<string>, "branchType" | "context" | "startFrom">;
	preTurnStartSelection?: ProcessTurnStartSelection | null;
	hasPreTurnTargetedInputs?: boolean;
}): ProcessTurnStartSelection {
	const authoredSelection = resolveProcessTurnStartSelection(input.turnDef);
	if (input.preTurnStartSelection) {
		return input.preTurnStartSelection;
	}
	if (input.hasPreTurnTargetedInputs) {
		return authoredSelection;
	}
	if (input.turnDef.context === "fresh" && input.turnDef.branchType === "primary") {
		return { kind: "session_root" };
	}
	if (
		input.turnDef.context === "fresh_seeded" &&
		input.turnDef.branchType === "primary" &&
		!input.turnDef.startFrom
	) {
		return { kind: "session_root" };
	}
	return authoredSelection;
}

export function planTurnTreeExecution(input: {
	turnDef: Pick<
		LlmTurnDefinition<string>,
		"branchType" | "context" | "startFrom" | "restorePrimaryLeafAfterTurn"
	>;
	currentLeafId: string | null;
	rootEntryId: string | null;
	semanticEntryRefs?: ProcessSemanticEntryRefs | null;
	productRefs?: ProcessProductRefs | null;
	entryExists?: (entryId: string) => boolean;
	preTurnStartSelection?: ProcessTurnStartSelection | null;
	hasPreTurnTargetedInputs?: boolean;
}): TurnTreePlan {
	const startTarget = resolveProcessTurnStartTarget({
		selection: resolveContextAwareTurnStartSelection({
			turnDef: input.turnDef,
			preTurnStartSelection: input.preTurnStartSelection,
			hasPreTurnTargetedInputs: input.hasPreTurnTargetedInputs,
		}),
		branchType: input.turnDef.branchType,
		currentLeafId: input.currentLeafId,
		rootEntryId: input.rootEntryId,
		semanticEntryRefs: input.semanticEntryRefs,
		productRefs: input.productRefs,
		entryExists: input.entryExists,
	});

	return {
		pathType: input.turnDef.branchType,
		forkPiEntryId: startTarget.forkPiEntryId,
		savedPrimaryLeafId: input.currentLeafId,
		restorePrimaryLeafAfterTurn: resolveLlmTurnRestorePrimaryLeafAfterTurn(input.turnDef),
		startTarget: startTarget.startTarget,
	};
}

export async function positionHandleForTurn(
	piHandle: Pick<PiTreeHandle, "branch" | "branchFromRoot">,
	plan: TurnTreePlan,
): Promise<void> {
	switch (plan.startTarget.kind) {
		case "current_leaf": {
			return;
		}
		case "entry": {
			await piHandle.branch(plan.startTarget.entryId);
			return;
		}
		case "root": {
			await piHandle.branchFromRoot();
			return;
		}
	}
}

export async function restoreHandleAfterTurn(
	piHandle: Pick<PiTreeHandle, "branch" | "branchFromRoot">,
	plan: TurnTreePlan,
): Promise<void> {
	if (!plan.restorePrimaryLeafAfterTurn) {
		return;
	}

	if (plan.savedPrimaryLeafId) {
		await piHandle.branch(plan.savedPrimaryLeafId);
		return;
	}

	await piHandle.branchFromRoot();
}

import {
	type ProcessSemanticEntryRefKey,
	type ProcessTurnRecordPathType,
	type ProcessTurnStartSelection,
	resolveProcessProductRefEntryId,
	resolveProcessSemanticRefEntryId,
} from "@leitwerk-dev/domain";
import { ensureIdentifiedPrompt } from "./identified-pi-entry.js";
import type { InputItem } from "./input-consumer.js";
import type { PiTreeHandle } from "./pi-adapter.js";
import { resolveRootEntryIdFromHandle, type TurnTreePlan } from "./turn-tree-strategy.js";
import type { readProcessProductRefs, readProcessSemanticEntryRefs } from "./worker-payloads.js";

export type PreTurnTargetedInput = Pick<
	InputItem,
	"inputId" | "sequence" | "source" | "bodyMarkdown"
> & {
	target: NonNullable<InputItem["target"]>;
};

export type AppliedTargetedInputMetadata = {
	currentPrimaryPathLeafId?: string | null;
	rootEntryId?: string | null;
	targetSemanticRef?: ProcessSemanticEntryRefKey | null;
	targetProductName?: string | null;
	targetEntryId?: string | null;
};

function resolveTargetSemanticRef(
	target: PreTurnTargetedInput["target"],
): ProcessSemanticEntryRefKey | null {
	return typeof target.semanticRef === "string" ? target.semanticRef : null;
}

function resolveTargetProductName(target: PreTurnTargetedInput["target"]): string | null {
	return typeof target.productName === "string" ? target.productName : null;
}

function formatTarget(target: PreTurnTargetedInput["target"]): string {
	const semanticRef = resolveTargetSemanticRef(target);
	if (semanticRef) {
		return `semantic ref '${semanticRef}'`;
	}
	return `product '${resolveTargetProductName(target) ?? "<unset>"}'`;
}

export function resolvePreTurnTargetStartSelection(
	inputs: readonly PreTurnTargetedInput[],
): ProcessTurnStartSelection | null {
	const target = inputs[0]?.target;
	if (target && resolveTargetSemanticRef(target) === "currentPrimaryPathLeaf") {
		return { kind: "semantic_ref", ref: "currentPrimaryPathLeaf" };
	}
	return null;
}

export function resolvePreTurnTargetEntryId(input: {
	target: PreTurnTargetedInput["target"];
	semanticEntryRefs: ReturnType<typeof readProcessSemanticEntryRefs>;
	productRefs: ReturnType<typeof readProcessProductRefs>;
	currentLeafId: string | null;
	rootEntryId: string | null;
	entryExists: (entryId: string) => boolean;
}): string | null {
	const semanticRef = resolveTargetSemanticRef(input.target);
	if (semanticRef) {
		return resolveProcessSemanticRefEntryId({
			ref: semanticRef,
			semanticEntryRefs: input.semanticEntryRefs,
			currentLeafId: input.currentLeafId,
			rootEntryId: input.rootEntryId,
			entryExists: input.entryExists,
		});
	}
	const productName = resolveTargetProductName(input.target);
	return productName
		? resolveProcessProductRefEntryId({
				productName,
				productRefs: input.productRefs,
				entryExists: input.entryExists,
			})
		: null;
}

export function validatePreTurnTargetedInputs(input: {
	turnId: string;
	inputs: readonly PreTurnTargetedInput[];
	treePlan: TurnTreePlan;
	semanticEntryRefs: ReturnType<typeof readProcessSemanticEntryRefs>;
	productRefs: ReturnType<typeof readProcessProductRefs>;
	currentLeafId: string | null;
	rootEntryId: string | null;
	entryExists: (entryId: string) => boolean;
}): string | null {
	const expectedEntryId =
		input.treePlan.startTarget.kind === "entry"
			? input.treePlan.startTarget.entryId
			: input.treePlan.startTarget.kind === "current_leaf"
				? input.currentLeafId
				: input.rootEntryId;

	for (const targetedInput of input.inputs) {
		if (targetedInput.bodyMarkdown.trim() === "") {
			return `Turn '${input.turnId}' cannot apply queued targeted input '${targetedInput.inputId}' because bodyMarkdown is empty`;
		}
		const targetEntryId = resolvePreTurnTargetEntryId({
			target: targetedInput.target,
			semanticEntryRefs: input.semanticEntryRefs,
			productRefs: input.productRefs,
			currentLeafId: input.currentLeafId,
			rootEntryId: input.rootEntryId,
			entryExists: input.entryExists,
		});
		if (!targetEntryId) {
			if (
				resolveTargetSemanticRef(targetedInput.target) === "rootEntry" &&
				input.treePlan.startTarget.kind === "root"
			) {
				continue;
			}
			return `Turn '${input.turnId}' cannot apply queued targeted input '${targetedInput.inputId}' because ${formatTarget(targetedInput.target)} is not resolved`;
		}
		if (!expectedEntryId || expectedEntryId !== targetEntryId) {
			return `Turn '${input.turnId}' cannot apply queued targeted input '${targetedInput.inputId}' for ${formatTarget(targetedInput.target)} because the selected turn is not continuing from that branch`;
		}
	}

	return null;
}

export async function applyPreTurnTargetedInputs(input: {
	piHandle: PiTreeHandle;
	inputs: readonly PreTurnTargetedInput[];
	pathType: ProcessTurnRecordPathType;
	/** Active-start recovery validates acknowledged inputs on the retained branch. */
	recoveryBaseEntryId?: string | null;
	reuseExistingWithoutBranching?: boolean;
	requireExisting?: boolean;
	onApplied?(inputId: string, sequence: number, meta?: AppliedTargetedInputMetadata): void;
}): Promise<void> {
	if (input.inputs.length === 0) {
		return;
	}
	for (const targetedInput of input.inputs) {
		const targetEntryId = await ensureIdentifiedPrompt({
			piHandle: input.piHandle,
			identity: { kind: "process_input", processInputId: targetedInput.inputId },
			content: targetedInput.bodyMarkdown,
			expectedParentId: input.recoveryBaseEntryId ?? input.piHandle.getLeafId(),
			allowDescendantParent: input.recoveryBaseEntryId !== undefined,
			requireOnCurrentBranch: input.reuseExistingWithoutBranching,
			reuseWithoutBranching: input.reuseExistingWithoutBranching,
			requireExisting: input.requireExisting,
		});
		const semanticRef = resolveTargetSemanticRef(targetedInput.target);
		input.onApplied?.(targetedInput.inputId, targetedInput.sequence, {
			...(input.pathType === "primary" ? { currentPrimaryPathLeafId: targetEntryId } : {}),
			rootEntryId: resolveRootEntryIdFromHandle(input.piHandle),
			...(semanticRef
				? { targetSemanticRef: semanticRef }
				: { targetProductName: resolveTargetProductName(targetedInput.target) }),
			targetEntryId,
		});
	}
}

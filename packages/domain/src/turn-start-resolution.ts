import type { ProcessTurnRecordPathType } from "./domain-model.js";
import type {
	ProcessProductRefs,
	ProcessSemanticEntryRefKey,
	ProcessSemanticEntryRefs,
} from "./semantic-entry-refs.js";

export interface ProcessTurnStartFromCurrentLeaf {
	kind: "current_leaf";
}

export interface ProcessTurnStartFromSessionRoot {
	/** Start with no persisted Pi entry in context. The kickoff entry has parentId null. */
	kind: "session_root";
}

export interface ProcessTurnStartFromEntry {
	kind: "entry";
	entryId: string;
}

export type ProcessTurnStartFallback =
	| ProcessTurnStartFromCurrentLeaf
	| ProcessTurnStartFromSessionRoot
	| ProcessTurnStartFromEntry;

export interface ProcessTurnStartFromSemanticRef {
	kind: "semantic_ref";
	ref: ProcessSemanticEntryRefKey;
	fallback?: ProcessTurnStartSelection;
}

export interface ProcessTurnStartFromProductRef {
	kind: "product_ref";
	productName: string;
	fallback?: ProcessTurnStartSelection;
}

export type ProcessTurnStartSelection =
	| ProcessTurnStartFallback
	| ProcessTurnStartFromSemanticRef
	| ProcessTurnStartFromProductRef;

export type ProcessTurnStartTarget =
	| { kind: "current_leaf" }
	| { kind: "entry"; entryId: string }
	| { kind: "root" };

export interface ProcessTurnStartResolution {
	forkPiEntryId: string | null;
	startTarget: ProcessTurnStartTarget;
}

export function defaultProcessTurnStartSelection(
	branchType: ProcessTurnRecordPathType,
): ProcessTurnStartFallback {
	switch (branchType) {
		case "primary":
		case "leaf_branch":
			return { kind: "current_leaf" };
		case "root_branch":
			return { kind: "session_root" };
	}
}

export function resolveProcessTurnStartSelection(input: {
	branchType: ProcessTurnRecordPathType;
	startFrom?: ProcessTurnStartSelection;
}): ProcessTurnStartSelection {
	return input.startFrom ?? defaultProcessTurnStartSelection(input.branchType);
}

export function resolveExistingProcessEntryId(
	entryId: string | null,
	entryExists?: ((entryId: string) => boolean) | undefined,
): string | null {
	if (!entryId) {
		return null;
	}
	return entryExists && !entryExists(entryId) ? null : entryId;
}

export function resolveProcessSemanticRefEntryId(input: {
	ref: keyof ProcessSemanticEntryRefs;
	semanticEntryRefs?: ProcessSemanticEntryRefs | null;
	currentLeafId: string | null;
	rootEntryId: string | null;
	entryExists?: (entryId: string) => boolean;
}): string | null {
	const fromState = resolveExistingProcessEntryId(
		input.semanticEntryRefs?.[input.ref]?.entryId ?? null,
		input.entryExists,
	);
	if (fromState) {
		return fromState;
	}
	if (input.ref === "currentPrimaryPathLeaf") {
		return resolveExistingProcessEntryId(input.currentLeafId, input.entryExists);
	}
	if (input.ref === "rootEntry") {
		return resolveExistingProcessEntryId(input.rootEntryId, input.entryExists);
	}
	return null;
}

export function resolveProcessProductRefEntryId(input: {
	productName: string;
	productRefs?: ProcessProductRefs | null;
	entryExists?: (entryId: string) => boolean;
}): string | null {
	const productName = input.productName.trim();
	if (!productName) {
		return null;
	}
	return resolveExistingProcessEntryId(
		input.productRefs?.[productName]?.entryId ?? null,
		input.entryExists,
	);
}

export function resolveProcessTurnStartTarget(input: {
	branchType: ProcessTurnRecordPathType;
	selection: ProcessTurnStartSelection;
	currentLeafId: string | null;
	rootEntryId: string | null;
	semanticEntryRefs?: ProcessSemanticEntryRefs | null;
	productRefs?: ProcessProductRefs | null;
	entryExists?: (entryId: string) => boolean;
}): ProcessTurnStartResolution {
	switch (input.selection.kind) {
		case "current_leaf": {
			return {
				forkPiEntryId: resolveExistingProcessEntryId(input.currentLeafId, input.entryExists),
				startTarget: { kind: "current_leaf" },
			};
		}
		case "session_root": {
			return {
				forkPiEntryId: null,
				startTarget: { kind: "root" },
			};
		}
		case "entry": {
			return {
				forkPiEntryId: input.selection.entryId,
				startTarget: { kind: "entry", entryId: input.selection.entryId },
			};
		}
		case "semantic_ref":
		case "product_ref": {
			const entryId =
				input.selection.kind === "semantic_ref"
					? resolveProcessSemanticRefEntryId({
							...input,
							ref: input.selection.ref,
						})
					: resolveProcessProductRefEntryId({
							...input,
							productName: input.selection.productName,
						});
			if (entryId) {
				return {
					forkPiEntryId: entryId,
					startTarget: { kind: "entry", entryId },
				};
			}

			return resolveProcessTurnStartTarget({
				...input,
				selection: input.selection.fallback ?? defaultProcessTurnStartSelection(input.branchType),
			});
		}
	}
}

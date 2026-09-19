import type { ProcessTurnRecordPathType } from "./domain-model.js";
import type {
	ProcessProductRefs,
	ProcessSemanticEntryRefKey,
	ProcessSemanticEntryRefs,
} from "./semantic-entry-refs.js";

/** @internal */
export interface ProcessTurnStartFromCurrentLeaf {
	/** @internal */
	kind: "current_leaf";
}

/** @internal */
export interface ProcessTurnStartFromSessionRoot {
	/** Start with no persisted Pi entry in context. The kickoff entry has parentId null. @internal */
	kind: "session_root";
}

/** @internal */
export interface ProcessTurnStartFromEntry {
	/** @internal */
	kind: "entry";
	/** @internal */
	entryId: string;
}

/** @internal */
export type ProcessTurnStartFallback =
	| ProcessTurnStartFromCurrentLeaf
	| ProcessTurnStartFromSessionRoot
	| ProcessTurnStartFromEntry;

/** @internal */
export interface ProcessTurnStartFromSemanticRef {
	/** @internal */
	kind: "semantic_ref";
	/** @internal */
	ref: ProcessSemanticEntryRefKey;
	/** @internal */
	fallback?: ProcessTurnStartSelection;
}

/** @internal */
export interface ProcessTurnStartFromProductRef {
	/** @internal */
	kind: "product_ref";
	/** @internal */
	productName: string;
	/** @internal */
	fallback?: ProcessTurnStartSelection;
}

/** @internal */
export type ProcessTurnStartSelection =
	| ProcessTurnStartFallback
	| ProcessTurnStartFromSemanticRef
	| ProcessTurnStartFromProductRef;

/** @internal */
export type ProcessTurnStartTarget =
	| {
			/** @internal */
			kind: "current_leaf";
	  }
	| {
			/** @internal */
			kind: "entry";
			/** @internal */
			entryId: string;
	  }
	| {
			/** @internal */
			kind: "root";
	  };

/** @internal */
export interface ProcessTurnStartResolution {
	/** @internal */
	forkPiEntryId: string | null;
	/** @internal */
	startTarget: ProcessTurnStartTarget;
}

/** @internal */
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

/** @internal */
export function resolveProcessTurnStartSelection(input: {
	/** @internal */
	branchType: ProcessTurnRecordPathType;
	/** @internal */
	startFrom?: ProcessTurnStartSelection;
}): ProcessTurnStartSelection {
	return input.startFrom ?? defaultProcessTurnStartSelection(input.branchType);
}

/** @internal */
export function resolveExistingProcessEntryId(
	entryId: string | null,
	entryExists?: ((entryId: string) => boolean) | undefined,
): string | null {
	if (!entryId) {
		return null;
	}
	return entryExists && !entryExists(entryId) ? null : entryId;
}

/** @internal */
export function resolveProcessSemanticRefEntryId(input: {
	/** @internal */
	ref: keyof ProcessSemanticEntryRefs;
	/** @internal */
	semanticEntryRefs?: ProcessSemanticEntryRefs | null;
	/** @internal */
	currentLeafId: string | null;
	/** @internal */
	rootEntryId: string | null;
	/** @internal */
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

/** @internal */
export function resolveProcessProductRefEntryId(input: {
	/** @internal */
	productName: string;
	/** @internal */
	productRefs?: ProcessProductRefs | null;
	/** @internal */
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

/** @internal */
export function resolveProcessTurnStartTarget(input: {
	/** @internal */
	branchType: ProcessTurnRecordPathType;
	/** @internal */
	selection: ProcessTurnStartSelection;
	/** @internal */
	currentLeafId: string | null;
	/** @internal */
	rootEntryId: string | null;
	/** @internal */
	semanticEntryRefs?: ProcessSemanticEntryRefs | null;
	/** @internal */
	productRefs?: ProcessProductRefs | null;
	/** @internal */
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

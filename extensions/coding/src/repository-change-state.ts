import type { Codec, StructuralProcessState } from "@leitwerk-dev/process-sdk";
import { parseStructuralProcessState } from "@leitwerk-dev/process-sdk";

/** @public */
export interface RepositoryChangeFinalizationState {
	/** @public */
	generatedCommitMessage: string | null;
}

/** @public */
export interface RepositoryChangeState extends StructuralProcessState {
	/** @public */
	finalization: RepositoryChangeFinalizationState;
	/** Namespaced state owned by a caller-supplied publication workflow. */
	/** @public */
	extensionState?: Record<string, unknown>;
}

/** @internal */
export function createEmptyRepositoryChangeFinalizationState(): RepositoryChangeFinalizationState {
	return { generatedCommitMessage: null };
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function toRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function parseFinalizationState(value: unknown): RepositoryChangeFinalizationState {
	const record = toRecord(value);
	return { generatedCommitMessage: stringOrNull(record.generatedCommitMessage) };
}

/** @internal */
export const repositoryChangeStateCodec: Codec<RepositoryChangeState> = {
	parse(value) {
		const record = toRecord(value);
		return {
			...parseStructuralProcessState(record),
			finalization: parseFinalizationState(record.finalization),
			extensionState: toRecord(record.extensionState),
		};
	},
	serialize(value) {
		return value;
	},
};

/** @internal */
export function clearReviewRefs(
	semanticEntryRefs: RepositoryChangeState["semanticEntryRefs"],
): RepositoryChangeState["semanticEntryRefs"] {
	return {
		...semanticEntryRefs,
		review: null,
	};
}

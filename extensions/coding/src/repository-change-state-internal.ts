import type { Codec, StructuralProcessState } from "@leitwerk-dev/process-sdk";
import { parseStructuralProcessState } from "@leitwerk-dev/process-sdk";

/** @public */
export interface RepositoryChangeFinalizationState {
	/** @public */
	generatedCommitMessage: string | null;
	/** Messages keyed by process project key. @public */
	commitMessages?: Record<string, string>;
}

/** @public */
export interface RepositoryChangeState extends StructuralProcessState {
	/** @public */
	finalization: RepositoryChangeFinalizationState;
	/** Completed routing decisions survive recovery. @public */
	routing?: {
		/** @public */
		plan?: {
			/** @internal */
			planRevision: number;
			/** @internal */ skip: boolean;
			/** @internal */ reason: string;
		};

		/** @public */
		simplification?: {
			/** @internal */
			skip: boolean;
			/** @internal */ reason: string;
		};
	};
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
	return {
		generatedCommitMessage: stringOrNull(record.generatedCommitMessage),
		...(record.commitMessages
			? {
					commitMessages: Object.fromEntries(
						Object.entries(toRecord(record.commitMessages)).filter(
							(entry): entry is [string, string] => typeof entry[1] === "string",
						),
					),
				}
			: {}),
	};
}

/** @internal */
export const repositoryChangeStateCodec: Codec<RepositoryChangeState> = {
	parse(value) {
		const record = toRecord(value);
		return {
			...parseStructuralProcessState(record),
			finalization: parseFinalizationState(record.finalization),
			extensionState: toRecord(record.extensionState),
			routing: toRecord(record.routing) as RepositoryChangeState["routing"],
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

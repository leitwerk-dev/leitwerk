import type { Codec, StructuralProcessState } from "@leitwerk-dev/process-sdk";
import { parseStructuralProcessState } from "@leitwerk-dev/process-sdk";

export interface RepositoryChangeFinalizationState {
	expectedPostConflictHeadSha: string | null;
	usedConflictResolution: boolean;
	finalizationSummaryMarkdown: string | null;
	finalizedHeadSha: string | null;
	generatedCommitMessage: string | null;
}

export interface RepositoryChangeState extends StructuralProcessState {
	finalization: RepositoryChangeFinalizationState;
}

export function createEmptyRepositoryChangeFinalizationState(): RepositoryChangeFinalizationState {
	return {
		expectedPostConflictHeadSha: null,
		usedConflictResolution: false,
		finalizationSummaryMarkdown: null,
		finalizedHeadSha: null,
		generatedCommitMessage: null,
	};
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
		expectedPostConflictHeadSha: stringOrNull(record.expectedPostConflictHeadSha),
		usedConflictResolution: record.usedConflictResolution === true,
		finalizationSummaryMarkdown: stringOrNull(record.finalizationSummaryMarkdown),
		finalizedHeadSha: stringOrNull(record.finalizedHeadSha),
		// Backward-compatible decoding for state persisted before commit-message generation.
		generatedCommitMessage: stringOrNull(record.generatedCommitMessage),
	};
}

export const repositoryChangeStateCodec: Codec<RepositoryChangeState> = {
	parse(value) {
		const record = toRecord(value);
		return {
			...parseStructuralProcessState(record),
			finalization: parseFinalizationState(record.finalization),
		};
	},
	serialize(value) {
		return value;
	},
};

export function clearReviewRefs(
	semanticEntryRefs: RepositoryChangeState["semanticEntryRefs"],
): RepositoryChangeState["semanticEntryRefs"] {
	return {
		...semanticEntryRefs,
		review: null,
	};
}

export function resetRepositoryChangeFinalizationState(
	overrides: Partial<RepositoryChangeFinalizationState> = {},
): RepositoryChangeFinalizationState {
	return {
		...createEmptyRepositoryChangeFinalizationState(),
		...overrides,
	};
}

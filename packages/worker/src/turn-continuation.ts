import type { ProcessInstance } from "@leitwerk-dev/domain";
import { DEFAULT_CONTINUE_PROMPT, normalizeContinuePrompt } from "@leitwerk-dev/domain";
import type { PiTreeHandle } from "./pi-adapter.js";
import type { PreTurnTargetedInput } from "./pre-turn-targeted-inputs.js";
import { TurnExecutionError } from "./turn-execution-error.js";
import { readProcessSemanticEntryRefs } from "./worker-payloads.js";

export type PromptlessTurnResumeReason =
	| "failed_turn_continue"
	| "targeted_follow_up"
	| "active_turn_resume";

function readCurrentLeafMessage(piHandle: Pick<PiTreeHandle, "getLeafId" | "getEntry">): {
	leafId: string | null;
	parentId: string | null;
	role: string | null;
	content: string | null;
} {
	const leafId = piHandle.getLeafId();
	if (!leafId) {
		return { leafId: null, parentId: null, role: null, content: null };
	}
	const entry = piHandle.getEntry(leafId);
	const role = entry?.message?.role;
	const content = entry?.message?.content;
	return {
		leafId,
		parentId: entry?.parentId ?? null,
		role: typeof role === "string" && role.trim() !== "" ? role : null,
		content: typeof content === "string" && content.trim() !== "" ? content.trim() : null,
	};
}

export async function prepareContinuationUserPrompt(input: {
	piHandle: PiTreeHandle;
	turnId: string;
	promptText: string;
}): Promise<string | null> {
	const normalizedPrompt = input.promptText.trim();
	if (normalizedPrompt === "") {
		throw new TurnExecutionError(
			input.turnId,
			"protocol_error",
			`Turn '${input.turnId}' cannot append an empty continuation prompt`,
		);
	}
	let currentLeaf = readCurrentLeafMessage(input.piHandle);
	if (!currentLeaf.leafId) {
		throw new TurnExecutionError(
			input.turnId,
			"infrastructure",
			`Turn '${input.turnId}' cannot append the continuation prompt because there is no active Pi leaf to continue from`,
		);
	}
	while (currentLeaf.role === "user") {
		if (currentLeaf.content === normalizedPrompt) return null;
		if (!currentLeaf.parentId) {
			throw new TurnExecutionError(
				input.turnId,
				"infrastructure",
				`Turn '${input.turnId}' cannot replace the saved continuation prompt at the root of the Pi tree`,
			);
		}
		await input.piHandle.branch(currentLeaf.parentId);
		currentLeaf = readCurrentLeafMessage(input.piHandle);
		if (!currentLeaf.leafId) {
			throw new TurnExecutionError(
				input.turnId,
				"infrastructure",
				`Turn '${input.turnId}' lost its continuation anchor while preparing a continuation prompt`,
			);
		}
	}
	return normalizedPrompt;
}

function readNonEmptyMetadataString(
	metadata: ProcessInstance["metadata"],
	key: string,
): string | null {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function resolveTurnContinuationState(input: {
	process: Pick<ProcessInstance, "selectedTurnId" | "metadata">;
	turnId: string;
	state: unknown;
}): {
	continueFromPiEntryId: string;
	continuePrompt: string;
	savedPrimaryLeafId: string | null;
} | null {
	if (input.process.selectedTurnId !== input.turnId) {
		return null;
	}
	const continueFromPiEntryId = readNonEmptyMetadataString(
		input.process.metadata,
		"continueFromPiEntryId",
	);
	const continueFromTurnRecordId = readNonEmptyMetadataString(
		input.process.metadata,
		"continueFromTurnRecordId",
	);
	if (!continueFromPiEntryId || !continueFromTurnRecordId) {
		return null;
	}
	return {
		continueFromPiEntryId,
		continuePrompt:
			normalizeContinuePrompt(input.process.metadata?.continuePrompt) ?? DEFAULT_CONTINUE_PROMPT,
		savedPrimaryLeafId:
			readNonEmptyMetadataString(input.process.metadata, "continueSavedPrimaryLeafEntryId") ??
			readProcessSemanticEntryRefs(input.state)?.currentPrimaryPathLeaf?.entryId ??
			null,
	};
}

export function resolvePromptlessTurnResumeReason(input: {
	process: Pick<ProcessInstance, "selectedTurnId">;
	acceptedTurnRecordId: string | null;
	turnId: string;
	hasFailedTurnContinuation: boolean;
	preTurnTargetedInputs: readonly Pick<PreTurnTargetedInput, "source">[];
	piHandleIsResumed: boolean;
	hasCurrentLeaf: boolean;
}): PromptlessTurnResumeReason | null {
	if (input.hasFailedTurnContinuation) {
		return "failed_turn_continue";
	}
	if (
		input.preTurnTargetedInputs.length > 0 &&
		input.preTurnTargetedInputs.every((targetedInput) => targetedInput.source === "action_prompt")
	) {
		return "targeted_follow_up";
	}
	if (
		input.piHandleIsResumed &&
		input.hasCurrentLeaf &&
		input.process.selectedTurnId === input.turnId &&
		typeof input.acceptedTurnRecordId === "string" &&
		input.acceptedTurnRecordId.trim() !== ""
	) {
		return "active_turn_resume";
	}
	return null;
}

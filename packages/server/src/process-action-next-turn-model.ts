import {
	type ProcessInstance,
	type ProcessTurnStartTarget,
	parseProcessStateJsonLenient,
	resolveExistingProcessEntryId,
	resolveProcessTurnStartSelection,
	resolveProcessTurnStartTarget,
} from "@leitwerk-dev/domain";
import { type LlmTurnDefinition, parseStructuralProcessState } from "@leitwerk-dev/process-sdk";
import type {
	ProcessActionModelResolutionPreview,
	ProcessActionWarmPromptCacheContext,
} from "@leitwerk-dev/protocol/http-contracts";
import type {
	ProcessTurnRecordLookup,
	TurnStartRecordLookup,
} from "./semantic-turn-result-markdown.js";

export type ProcessActionResolvedModelSummary = ProcessActionModelResolutionPreview;

export interface ProcessActionNextTurnModelSummary {
	resolvedModel: ProcessActionResolvedModelSummary;
	warmPromptCache?: ProcessActionWarmPromptCacheContext;
}

const PROMPT_CACHE_WARM_MS = 30 * 60 * 1000;

function assertUnreachableStartTarget(value: never): never {
	throw new Error(`Unhandled process turn start target: ${JSON.stringify(value)}`);
}

function resolveContinuationEntryId(input: {
	startTarget: ProcessTurnStartTarget;
	currentLeafId: string | null;
	rootEntryId: string | null;
}): string | null {
	switch (input.startTarget.kind) {
		case "root":
			return null;
		case "current_leaf":
			return input.currentLeafId !== null && input.currentLeafId !== input.rootEntryId
				? input.currentLeafId
				: null;
		case "entry":
			return input.startTarget.entryId !== input.rootEntryId ? input.startTarget.entryId : null;
		default:
			return assertUnreachableStartTarget(input.startTarget);
	}
}

function findContextTurnRecord(input: {
	process: ProcessInstance;
	entryId: string;
	semanticEntryRefs: readonly ({ entryId: string; turnRecordId?: string | null } | null)[];
	turnRecords: ProcessTurnRecordLookup;
}): ReturnType<ProcessTurnRecordLookup["getById"]> {
	const semanticRef = input.semanticEntryRefs.find(
		(ref) => ref?.entryId === input.entryId && ref.turnRecordId,
	);
	if (semanticRef?.turnRecordId) {
		const record = input.turnRecords.getById(semanticRef.turnRecordId);
		if (record?.instanceId === input.process.id && record.resultPiEntryId === input.entryId) {
			return record;
		}
	}
	return (
		[...input.turnRecords.listByInstance(input.process.id)]
			.reverse()
			.find((record) => record.resultPiEntryId === input.entryId) ?? null
	);
}

function buildWarmPromptCache(input: {
	process: ProcessInstance;
	continuationEntryId: string | null;
	semanticEntryRefs: readonly ({ entryId: string; turnRecordId?: string | null } | null)[];
	turnRecords?: ProcessTurnRecordLookup;
	turnStarts?: TurnStartRecordLookup;
	now: () => number;
	resolveCompatibleModelProfileIds?: (providerId: string, modelId: string) => readonly string[];
}): ProcessActionWarmPromptCacheContext | undefined {
	if (!input.continuationEntryId || !input.turnRecords || !input.turnStarts) return undefined;
	const record = findContextTurnRecord({
		process: input.process,
		entryId: input.continuationEntryId,
		semanticEntryRefs: input.semanticEntryRefs,
		turnRecords: input.turnRecords,
	});
	const profileId = record?.modelProfileId?.trim() ?? "";
	const endedAt = record?.endedAt ?? null;
	const endedAtMs = endedAt === null ? Number.NaN : Date.parse(endedAt);
	const start = record?.turnStartRecordId
		? input.turnStarts.getById(record.turnStartRecordId)
		: null;
	const executedModel = start?.state.kind === "accepted" ? start.state.start : null;
	if (
		!record ||
		profileId === "" ||
		!endedAt ||
		!Number.isFinite(endedAtMs) ||
		executedModel?.kind !== "llm"
	) {
		return undefined;
	}
	const expiresAtMs = endedAtMs + PROMPT_CACHE_WARM_MS;
	const ageMs = input.now() - endedAtMs;
	if (ageMs < 0 || input.now() > expiresAtMs) return undefined;
	const compatibleModelProfileIds = input.resolveCompatibleModelProfileIds
		? [
				...input.resolveCompatibleModelProfileIds(
					executedModel.model.providerId,
					executedModel.model.modelId,
				),
			]
		: [];
	return {
		previousModelProfileId: profileId,
		compatibleModelProfileIds,
		expiresAt: new Date(expiresAtMs).toISOString(),
	};
}

export function buildProcessActionNextTurnModelSummary(input: {
	process: ProcessInstance;
	candidateTurnDef: LlmTurnDefinition;
	entryExists?: (entryId: string) => boolean;
	turnRecords?: ProcessTurnRecordLookup;
	turnStarts?: TurnStartRecordLookup;
	now?: () => number;
	resolvedModel: ProcessActionResolvedModelSummary;
	resolveCompatibleModelProfileIds?: (providerId: string, modelId: string) => readonly string[];
}): ProcessActionNextTurnModelSummary {
	const structuralState = parseStructuralProcessState(
		parseProcessStateJsonLenient(input.process.stateJson),
	);
	const currentLeafId = resolveExistingProcessEntryId(
		structuralState.semanticEntryRefs.currentPrimaryPathLeaf?.entryId ?? null,
		input.entryExists,
	);
	const rootEntryId = resolveExistingProcessEntryId(
		structuralState.semanticEntryRefs.rootEntry?.entryId ?? null,
		input.entryExists,
	);
	const startTarget = resolveProcessTurnStartTarget({
		branchType: input.candidateTurnDef.branchType,
		selection: resolveProcessTurnStartSelection(input.candidateTurnDef),
		currentLeafId,
		rootEntryId,
		semanticEntryRefs: structuralState.semanticEntryRefs,
		productRefs: structuralState.productRefs,
		entryExists: input.entryExists,
	});
	const continuationEntryId = resolveContinuationEntryId({
		startTarget: startTarget.startTarget,
		currentLeafId,
		rootEntryId,
	});

	return {
		resolvedModel: input.resolvedModel,
		warmPromptCache: buildWarmPromptCache({
			process: input.process,
			continuationEntryId,
			semanticEntryRefs: Object.values(structuralState.semanticEntryRefs),
			turnRecords: input.turnRecords,
			turnStarts: input.turnStarts,
			now: input.now ?? Date.now,
			resolveCompatibleModelProfileIds: input.resolveCompatibleModelProfileIds,
		}),
	};
}

import type { ProcessInstance, TurnStartRecord } from "@leitwerk-dev/domain";
import {
	createEmptyStructuralProcessState,
	type LlmTurnDefinition,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { buildProcessActionNextTurnModelSummary } from "./process-action-next-turn-model.js";
import { createTestTurnRecord } from "./test-helpers/process-model-fixtures.js";

type PreviewState = ReturnType<typeof createEmptyStructuralProcessState> & {
	mode?: string | null;
};

function createPreviewState(overrides: Partial<PreviewState> = {}): PreviewState {
	return {
		...createEmptyStructuralProcessState(),
		mode: null,
		...overrides,
		semanticEntryRefs: {
			...createEmptyStructuralProcessState().semanticEntryRefs,
			...(overrides.semanticEntryRefs ?? {}),
		},
	};
}

const implementFast = {
	id: "implement_fast",
	description: "Implement fast",
	kind: "llm",
	completionMode: "turn_end",
	branchType: "primary",
	context: "full",
	prompt: async () => "implement",
	outcomes: { done: { description: "done", parameters: {} } },
} satisfies LlmTurnDefinition;

const turnRecord = createTestTurnRecord({
	id: "trn_previous",
	instanceId: "agt_preview_1",
	turnId: "implement_fast",
	turnStartRecordId: "tsr_previous",
	acceptedWorkerLeaseId: "lease_previous",
	forkPiEntryId: "root-user",
	resultPiEntryId: "previous-leaf",
	modelProfileId: "claude_fast",
});

function createTurnStart(overrides: Partial<TurnStartRecord> = {}): TurnStartRecord {
	return {
		id: "tsr_previous",
		instanceId: "agt_preview_1",
		turnId: "implement_fast",
		turnType: "llm",
		proposedTurnRecordId: "trn_previous",
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: {
				kind: "llm",
				model: {
					profileId: "claude_fast",
					providerId: "fixture-provider",
					modelId: "fixture-model",
					thinkingLevel: "off",
				},
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: "digest",
				workerRuntimeProfileId: "default",
				piSettings: {},
			},
			turnRecordId: "trn_previous",
			acceptedWorkerLeaseId: "lease_previous",
		},
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function createProcess(overrides: Partial<ProcessInstance> = {}): ProcessInstance {
	return {
		id: "agt_preview_1",
		processId: "action_preview_process",
		selectedTurnId: "human_decision",
		lifecycleStatus: "waiting",
		currentExecution: null,
		planRevision: 0,
		title: null,
		externalId: null,
		externalUrl: null,
		metadata: null,
		defaultModelProfileId: null,
		turnConfigsJson: null,
		selectedTurnModelProfileId: null,
		paramsJson: "{}",
		stateJson: JSON.stringify(createPreviewState({})),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

const resolvedClaudeFast = {
	status: "resolved" as const,
	modelProfileId: "claude_fast",
	source: "catalog_default" as const,
	error: null,
};

describe("buildProcessActionNextTurnModelSummary", () => {
	it("uses the policy-resolved next-turn model", () => {
		const summary = buildProcessActionNextTurnModelSummary({
			process: createProcess(),
			candidateTurnDef: implementFast,
			resolvedModel: resolvedClaudeFast,
		});

		expect(summary).toEqual({
			resolvedModel: resolvedClaudeFast,
			warmPromptCache: undefined,
		});
	});

	it("uses the route-supplied entry existence check for warm continuation context", () => {
		const process = createProcess({
			stateJson: JSON.stringify(
				createPreviewState({
					semanticEntryRefs: {
						rootEntry: { entryId: "root-user", turnRecordId: null },
						currentPrimaryPathLeaf: { entryId: "previous-leaf", turnRecordId: turnRecord.id },
					},
				}),
			),
		});
		const project = (entryExists: (id: string) => boolean) =>
			buildProcessActionNextTurnModelSummary({
				process,
				candidateTurnDef: implementFast,
				resolvedModel: resolvedClaudeFast,
				turnRecords: { getById: () => turnRecord, listByInstance: () => [turnRecord] },
				turnStarts: { getById: () => createTurnStart() },
				now: () => Date.parse("2026-01-01T00:02:00.000Z"),
				entryExists,
			});
		expect(project(() => true).warmPromptCache?.previousModelProfileId).toBe("claude_fast");
		expect(project((id) => id === "root-user").warmPromptCache).toBeUndefined();
	});

	it("delegates compatibility using the durably executed provider and model", () => {
		const resolveCompatibleModelProfileIds = vi.fn(() => ["claude_fast", "claude_thinking"]);
		const record = turnRecord;
		const process = createProcess({
			defaultModelProfileId: "other",
			stateJson: JSON.stringify(
				createPreviewState({
					semanticEntryRefs: {
						rootEntry: { entryId: "root-user", turnRecordId: null },
						currentPrimaryPathLeaf: {
							entryId: "previous-leaf",
							turnRecordId: record.id,
						},
					},
				}),
			),
		});
		const summary = buildProcessActionNextTurnModelSummary({
			process,
			candidateTurnDef: implementFast,
			resolvedModel: {
				status: "resolved",
				modelProfileId: "other",
				source: "instance_default",
				error: null,
			},
			turnRecords: { getById: () => record, listByInstance: () => [record] },
			turnStarts: { getById: () => createTurnStart() },
			now: () => Date.parse("2026-01-01T00:31:00.000Z"),
			resolveCompatibleModelProfileIds,
		});

		expect(resolveCompatibleModelProfileIds).toHaveBeenCalledWith(
			"fixture-provider",
			"fixture-model",
		);
		expect(summary?.resolvedModel.modelProfileId).toBe("other");
		expect(summary?.warmPromptCache).toEqual({
			previousModelProfileId: "claude_fast",
			compatibleModelProfileIds: ["claude_fast", "claude_thinking"],
			expiresAt: "2026-01-01T00:31:00.000Z",
		});
	});

	it("returns compatibility resolved for the durably executed model", () => {
		const resolveCompatibleModelProfileIds = vi.fn((providerId: string, modelId: string) =>
			providerId === "fixture-provider" && modelId === "fixture-model" ? ["claude_equivalent"] : [],
		);
		const record = turnRecord;
		const summary = buildProcessActionNextTurnModelSummary({
			process: createProcess({
				stateJson: JSON.stringify(
					createPreviewState({
						semanticEntryRefs: {
							rootEntry: { entryId: "root-user", turnRecordId: null },
							currentPrimaryPathLeaf: {
								entryId: "previous-leaf",
								turnRecordId: record.id,
							},
						},
					}),
				),
			}),
			candidateTurnDef: implementFast,
			resolvedModel: resolvedClaudeFast,
			turnRecords: { getById: () => record, listByInstance: () => [record] },
			turnStarts: { getById: () => createTurnStart() },
			now: () => Date.parse("2026-01-01T00:02:00.000Z"),
			resolveCompatibleModelProfileIds,
		});

		expect(summary?.warmPromptCache?.compatibleModelProfileIds).toEqual(["claude_equivalent"]);
	});

	it("marks continuation context cold just beyond 30 minutes", () => {
		const record = turnRecord;
		const summary = buildProcessActionNextTurnModelSummary({
			process: createProcess({
				stateJson: JSON.stringify(
					createPreviewState({
						semanticEntryRefs: {
							rootEntry: { entryId: "root-user", turnRecordId: null },
							currentPrimaryPathLeaf: {
								entryId: "previous-leaf",
								turnRecordId: record.id,
							},
						},
					}),
				),
			}),
			candidateTurnDef: implementFast,
			resolvedModel: resolvedClaudeFast,
			turnRecords: { getById: () => record, listByInstance: () => [record] },
			turnStarts: { getById: () => createTurnStart() },
			now: () => Date.parse("2026-01-01T00:31:00.001Z"),
		});

		expect(summary?.warmPromptCache).toBeUndefined();
	});
});

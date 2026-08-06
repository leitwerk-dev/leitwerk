import { buildFailedTurnRecoveryMetadata as genericFailedTurnRecovery } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { createDefaultTestProcessGraphRegistry } from "../../test-helpers/process-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import { buildContinueFailedTurnWrites } from "./build-continue-failed-turn-writes.js";

const processGraphs = createDefaultTestProcessGraphRegistry();

type ContinuePlanInput = {
	turnRecordId: string;
	continueFromPiEntryId: string;
	metadata?: Record<string, unknown> | null;
	stateJson?: string;
	attemptNumber?: number;
	pathType?: "primary" | "root_branch";
	resultPiEntryId?: string | null;
	modelProfileId?: string | null;
	prompt?: string;
};

function stateWithPrimaryLeaf(entryId: string, turnRecordId: string): string {
	return JSON.stringify({
		semanticEntryRefs: { currentPrimaryPathLeaf: { entryId, turnRecordId } },
	});
}

function planContinue(input: ContinuePlanInput) {
	const deps = createTestDeps();
	const process = deps.processes.create({
		processId: "jira_issue_process",
		selectedTurnId: "implement",
		lifecycleStatus: "error",
		metadata: input.metadata ?? genericFailedTurnRecovery(input.turnRecordId),
		...(input.stateJson ? { stateJson: input.stateJson } : {}),
	});
	const failedRun = deps.turnRecords.create({
		id: input.turnRecordId,
		instanceId: process.id,
		turnId: "implement",
		status: "failed",
		attemptNumber: input.attemptNumber ?? 1,
		pathType: input.pathType ?? "primary",
		resultPiEntryId:
			input.resultPiEntryId === undefined ? input.continueFromPiEntryId : input.resultPiEntryId,
		...(input.modelProfileId !== undefined ? { modelProfileId: input.modelProfileId } : {}),
	});
	const turnStartRecordId = failedRun.turnStartRecordId;
	if (!turnStartRecordId) {
		throw new Error("Expected the failed turn fixture to reference a turn start");
	}
	const acceptedStart = deps.turnStarts.getById(turnStartRecordId);
	if (!acceptedStart) {
		throw new Error(`Expected turn start ${turnStartRecordId} to exist`);
	}
	return {
		process,
		failedRun,
		planned: buildContinueFailedTurnWrites({
			processGraphs,
			process,
			failedRun,
			acceptedStart,
			continueFromPiEntryId: input.continueFromPiEntryId,
			...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
		}),
	};
}

describe("buildContinueFailedTurnWrites", () => {
	it("reactivates the failed turn and preserves continuation lineage metadata", () => {
		const { process, planned } = planContinue({
			turnRecordId: "trn_impl_8",
			continueFromPiEntryId: "assistant-aborted-8",
			attemptNumber: 2,
			modelProfileId: "claude_fast",
			metadata: {
				externalRef: "JRA-123",
				retryForkPiEntryId: "stale-retry-node",
				retryFromTurnRecordId: "trn_old_retry",
				...genericFailedTurnRecovery("trn_impl_8"),
			},
			stateJson: stateWithPrimaryLeaf("primary-leaf-7", "trn_impl_7"),
		});

		expect(planned.processPatch).toMatchObject({
			lifecycleStatus: "active",
			selectedTurnModelProfileId: "claude_fast",
			metadata: {
				externalRef: "JRA-123",
				continueFromTurnRecordId: "trn_impl_8",
				continueFromPiEntryId: "assistant-aborted-8",
				continuePrompt: "continue",
			},
		});
		expect(planned.changedFields).toEqual(
			expect.arrayContaining(["lifecycleStatus", "selectedTurnModelProfileId", "metadata"]),
		);
		expect(planned.workerIntent).toEqual({ kind: "restart_worker" });
		expect(planned.events).toMatchObject([
			{
				instanceId: process.id,
				eventType: "continue_scheduled",
				data: {
					selectedTurnId: "implement",
					continueFromTurnRecordId: "trn_impl_8",
					continueFromPiEntryId: "assistant-aborted-8",
					attemptNumber: 2,
				},
			},
		]);
		expect(planned.broadcasts).toMatchObject([
			{
				type: "process.event",
				payload: { eventType: "continue_scheduled", level: "info" },
				instanceId: process.id,
			},
		]);
	});

	it("keeps failed-turn recovery metadata until the replacement turn starts", () => {
		const { planned } = planContinue({
			turnRecordId: "trn_impl_recoverable",
			continueFromPiEntryId: "assistant-recoverable",
			metadata: genericFailedTurnRecovery("trn_impl_recoverable", {
				suggestedContinuePrompt: "Please finish the result.",
				failureCode: "missing_markdown_result",
				missingToolNames: ["markdown_result"],
			}),
		});

		expect(planned.processPatch.metadata).toMatchObject({
			continueFromTurnRecordId: "trn_impl_recoverable",
			continueFromPiEntryId: "assistant-recoverable",
			continuePrompt: "Please finish the result.",
			failedTurnRecovery: {
				turnRecordId: "trn_impl_recoverable",
				strategy: "continue",
			},
		});
	});

	it.each([
		{
			name: "reuses the persisted continue prompt when a scheduled continue is retried before turn start",
			turnRecordId: "trn_impl_recoverable_retry",
			continueFromPiEntryId: "assistant-recoverable",
			metadataPrompt: "Use the operator-approved recovery prompt.",
			expectedPrompt: "Use the operator-approved recovery prompt.",
		},
		{
			name: "uses a saved branch prompt ahead of a persisted continue prompt",
			turnRecordId: "trn_impl_saved_prompt",
			continueFromPiEntryId: "user-saved-prompt",
			metadataPrompt: "Persisted prompt from an earlier schedule.",
			prompt: "Saved branch prompt.",
			expectedPrompt: "Saved branch prompt.",
		},
	])("$name", ({ turnRecordId, continueFromPiEntryId, metadataPrompt, prompt, expectedPrompt }) => {
		const { planned } = planContinue({
			turnRecordId,
			continueFromPiEntryId,
			prompt,
			metadata: {
				continuePrompt: metadataPrompt,
				...genericFailedTurnRecovery(turnRecordId),
			},
		});

		expect(planned.processPatch.metadata).toMatchObject({
			continueFromTurnRecordId: turnRecordId,
			continueFromPiEntryId,
			continuePrompt: expectedPrompt,
		});
	});

	it("preserves the saved primary leaf only for non-primary continuation branches", () => {
		const { planned } = planContinue({
			turnRecordId: "trn_review_8",
			continueFromPiEntryId: "review-aborted-8",
			pathType: "root_branch",
			attemptNumber: 2,
			stateJson: stateWithPrimaryLeaf("primary-leaf-7", "trn_impl_7"),
		});

		expect(planned.processPatch.metadata).toMatchObject({
			continueFromTurnRecordId: "trn_review_8",
			continueFromPiEntryId: "review-aborted-8",
			continuePrompt: "continue",
			continueSavedPrimaryLeafEntryId: "primary-leaf-7",
		});
	});

	it("uses a derived continuation leaf when the failed run did not persist one directly", () => {
		const { planned } = planContinue({
			turnRecordId: "trn_impl_derived_leaf",
			continueFromPiEntryId: "assistant-derived-3",
			attemptNumber: 3,
			resultPiEntryId: null,
		});

		expect(planned.processPatch.metadata).toMatchObject({
			continueFromTurnRecordId: "trn_impl_derived_leaf",
			continueFromPiEntryId: "assistant-derived-3",
			continuePrompt: "continue",
		});
		expect(planned.events[0]).toMatchObject({
			eventType: "continue_scheduled",
			data: { continueFromPiEntryId: "assistant-derived-3" },
		});
	});

	it("clears stale continuation restore metadata when the failed leaf is already primary", () => {
		const { planned } = planContinue({
			turnRecordId: "trn_impl_9",
			continueFromPiEntryId: "assistant-aborted-9",
			metadata: {
				externalRef: "JRA-456",
				continueSavedPrimaryLeafEntryId: "stale-primary-node",
				...genericFailedTurnRecovery("trn_impl_9"),
			},
			stateJson: stateWithPrimaryLeaf("assistant-aborted-9", "trn_impl_9"),
		});

		expect(planned.processPatch.metadata).toMatchObject({
			externalRef: "JRA-456",
			continueFromTurnRecordId: "trn_impl_9",
			continueFromPiEntryId: "assistant-aborted-9",
			continuePrompt: "continue",
		});
		expect(planned.processPatch.metadata).not.toHaveProperty("continueSavedPrimaryLeafEntryId");
	});
});

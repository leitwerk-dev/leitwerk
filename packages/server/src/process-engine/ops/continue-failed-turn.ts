import {
	type Actor,
	normalizeContinuePrompt,
	type ProcessTurnRecord,
	readFailedTurnRecoveryContext,
} from "@leitwerk-dev/domain";
import {
	resolveTurnContinuationLeafEntryId,
	resolveTurnContinuationUserPrompt,
} from "@leitwerk-dev/protocol";
import type { ReadonlyPiSessionTree } from "../../pi-session-tree.js";
import { accept, reject } from "../decision.js";
import { defineOperation } from "../operation.js";
import { readCurrentPrimaryPathLeafEntryId } from "../state-json.js";
import type { ProcessEngineDeps } from "../types.js";
import { buildContinueFailedTurnWrites } from "../writes/build-continue-failed-turn-writes.js";
import { stampActorOnEvents } from "../writes/writes.js";

export interface ContinueFailedTurnInput {
	instanceId: string;
	turnRecordId: string;
	options?: {
		prompt?: string | null;
		nextTurnModelProfileId?: string | null;
		providerOptions?: Readonly<Record<string, string>>;
		actor?: Actor;
	};
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim() !== "") {
		return error.message;
	}
	return String(error);
}

async function validateContinueFailedTurnPreflight(
	deps: ProcessEngineDeps,
	process: { id: string; stateJson: string | null },
	failedRun: Pick<
		ProcessTurnRecord,
		"id" | "forkPiEntryId" | "resultPiEntryId" | "startedAt" | "endedAt" | "pathType"
	>,
): Promise<
	| { ok: true; continueFromPiEntryId: string; continuePrompt: string | null }
	| { ok: false; message: string }
> {
	if (!deps.sessionReader) {
		return {
			ok: false,
			message:
				"Saved progress inspection is not configured, so this failed turn cannot be continued",
		};
	}

	let tree: ReadonlyPiSessionTree;
	try {
		tree = await deps.sessionReader.readPiSessionTree(process.id);
	} catch (error) {
		return {
			ok: false,
			message: `Could not inspect saved progress for continuation: ${toErrorMessage(error)}`,
		};
	}

	const continuationBounds = { endedAt: failedRun.endedAt };
	const continueFromPiEntryId = resolveTurnContinuationLeafEntryId(
		tree.entries,
		failedRun,
		continuationBounds,
	);
	if (!continueFromPiEntryId) {
		return {
			ok: false,
			message: "This failed turn does not have saved progress that can be continued",
		};
	}
	const continuePrompt = resolveTurnContinuationUserPrompt(
		tree.entries,
		failedRun,
		continuationBounds,
	);

	const savedPrimaryLeafEntryId = readCurrentPrimaryPathLeafEntryId(process.stateJson);
	if (
		failedRun.pathType !== "primary" &&
		savedPrimaryLeafEntryId &&
		savedPrimaryLeafEntryId !== continueFromPiEntryId &&
		!tree.getEntry(savedPrimaryLeafEntryId)
	) {
		return {
			ok: false,
			message:
				"This failed turn cannot be continued safely because the saved process state is incomplete",
		};
	}

	return { ok: true, continueFromPiEntryId, continuePrompt };
}

export const ContinueFailedTurn = defineOperation<
	"continue_failed_turn",
	ContinueFailedTurnInput,
	void
>({
	kind: "continue_failed_turn",
	label: "Continue failed turn",
	messages: {
		reconcileErrorMessage: "Process was reactivated, but the worker could not be started cleanly",
	},
	async decide(ctx, input) {
		if (ctx.process.lifecycleStatus !== "error") {
			return reject("invalid_transition", "Process is not in an error state");
		}
		const startId =
			ctx.process.currentExecution?.kind === "worker_start"
				? ctx.process.currentExecution.id
				: null;
		const acceptedStart = startId ? ctx.deps.turnStarts.getById(startId) : null;
		if (
			acceptedStart?.state.kind !== "accepted" ||
			acceptedStart.state.turnRecordId !== input.turnRecordId
		) {
			return reject("stale_turn_record", "Only the current failed turn record can be continued");
		}
		const failedRun = ctx.deps.turnRecords.getById(input.turnRecordId);
		if (failedRun?.status !== "failed") {
			return reject("retry_target_missing", "No failed turn record is available for continuation");
		}
		if (failedRun.turnType !== "llm") {
			return reject("invalid_transition", "Only failed LLM turns can be continued");
		}
		if (!readFailedTurnRecoveryContext(ctx.process.metadata, failedRun.id)) {
			return reject("invalid_transition", "This failed turn is not continuable");
		}
		const preflight = await validateContinueFailedTurnPreflight(ctx.deps, ctx.process, failedRun);
		if (!preflight.ok) {
			return reject("invalid_transition", preflight.message);
		}

		const writes = buildContinueFailedTurnWrites({
			processGraphs: ctx.deps.processGraphs,
			process: ctx.process,
			failedRun,
			acceptedStart,
			continueFromPiEntryId: preflight.continueFromPiEntryId,
			prompt: normalizeContinuePrompt(input.options?.prompt) ?? preflight.continuePrompt,
		});
		stampActorOnEvents(writes, input.options?.actor, "continue_scheduled");
		return accept({
			writes,
			metadata:
				input.options?.nextTurnModelProfileId !== undefined ||
				input.options?.providerOptions !== undefined
					? {
							...(input.options.nextTurnModelProfileId !== undefined
								? { nextTurnModelProfileId: input.options.nextTurnModelProfileId }
								: {}),
							...(input.options.providerOptions !== undefined
								? { providerOptions: input.options.providerOptions }
								: {}),
						}
					: undefined,
		});
	},
});

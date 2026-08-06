import type { WorkerBootstrapReceipt } from "@leitwerk-dev/domain";
import type { LlmTurnDefinition } from "@leitwerk-dev/process-sdk";
import { getProcessTurnGraph } from "../../process-graph.js";
import { accept, noWrites, reject } from "../decision.js";
import { defineOperation } from "../operation.js";

export interface AcceptWorkerTurnStartInput {
	instanceId: string;
	workerLeaseId: string;
	startRecordId: string;
	proposedTurnRecordId: string;
}

function receiptMatchesStart(
	receipt: WorkerBootstrapReceipt,
	startId: string,
	leaseId: string,
): boolean {
	return receipt.startRecordId === startId && receipt.workerLeaseId === leaseId;
}

const CONTINUATION_METADATA_KEYS = [
	"continueFromPiEntryId",
	"continueFromTurnRecordId",
	"continueSavedPrimaryLeafEntryId",
	"continuePrompt",
	"failedTurnRecovery",
] as const;

function metadataAfterAcceptedContinue(
	metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
	const next = metadata ? { ...metadata } : {};
	for (const key of CONTINUATION_METADATA_KEYS) delete next[key];
	return Object.keys(next).length > 0 ? next : null;
}

function preparedStartMatchesDefinition(
	prepared: NonNullable<Extract<WorkerBootstrapReceipt, { kind: "llm" }>["preparedStart"]>,
	definition: LlmTurnDefinition,
): boolean {
	if (prepared.pathType !== definition.branchType || prepared.contextMode !== definition.context) {
		return false;
	}
	switch (prepared.startTarget.kind) {
		case "current_leaf":
			return prepared.forkPiEntryId === null || prepared.forkPiEntryId.trim() !== "";
		case "entry":
			return (
				prepared.startTarget.entryId.trim() !== "" &&
				prepared.forkPiEntryId === prepared.startTarget.entryId
			);
		case "root":
			return prepared.forkPiEntryId === null;
	}
}

export const AcceptWorkerTurnStart = defineOperation<
	"accept_worker_turn_start",
	AcceptWorkerTurnStartInput,
	{ turnRecordId: string }
>({
	kind: "accept_worker_turn_start",
	label: "Accept worker turn start",
	decide(ctx, input) {
		if (
			ctx.process.lifecycleStatus !== "active" ||
			ctx.process.currentExecution?.kind !== "worker_start" ||
			ctx.process.currentExecution.id !== input.startRecordId
		) {
			return reject("stale_turn_start", "Worker start is no longer current and active");
		}
		const start = ctx.deps.turnStarts.getById(input.startRecordId);
		if (
			!start ||
			start.instanceId !== ctx.process.id ||
			start.proposedTurnRecordId !== input.proposedTurnRecordId ||
			start.turnId !== ctx.process.selectedTurnId
		) {
			return reject("stale_turn_start", "Worker start does not match the selected process turn");
		}
		const lease = ctx.deps.leases.getByInstance(ctx.process.id);
		if (
			!lease ||
			lease.id !== input.workerLeaseId ||
			!lease.bootstrapReceipt ||
			!receiptMatchesStart(lease.bootstrapReceipt, start.id, lease.id)
		) {
			return reject("worker_receipt_invalid", "Worker lease has no matching bootstrap receipt");
		}
		if (start.state.kind === "accepted") {
			if (
				start.state.turnRecordId === input.proposedTurnRecordId &&
				start.state.acceptedWorkerLeaseId === lease.id
			)
				return noWrites({ data: { turnRecordId: start.state.turnRecordId } });
			return reject(
				"turn_start_already_accepted",
				"Worker start was accepted with a different identity",
			);
		}
		if (start.state.kind !== "starting")
			return reject("turn_start_not_starting", "Worker start is not awaiting acceptance");
		const definition = getProcessTurnGraph(
			ctx.deps.processGraphs,
			ctx.process.processId,
			start.turnId,
		);
		if (!definition || definition.turnType !== start.turnType)
			return reject("turn_start_invalid", "Current process definition rejects this worker start");
		if (start.turnType === "llm") {
			const authoredDefinition = ctx.deps.processGraphs
				.get(ctx.process.processId)
				?.turns.get(start.turnId)?.definition;
			if (
				lease.bootstrapReceipt.kind !== "llm" ||
				start.state.start.kind !== "llm" ||
				!lease.bootstrapReceipt.preparedStart ||
				!authoredDefinition ||
				authoredDefinition.kind !== "llm" ||
				!preparedStartMatchesDefinition(lease.bootstrapReceipt.preparedStart, authoredDefinition) ||
				lease.bootstrapReceipt.verifiedResourceSnapshotDigest !==
					start.state.start.piResourceSnapshotDigest ||
				lease.bootstrapReceipt.resolvedModel.providerId !== start.state.start.model.providerId ||
				lease.bootstrapReceipt.resolvedModel.modelId !== start.state.start.model.modelId
			)
				return reject(
					"worker_receipt_invalid",
					"LLM bootstrap receipt does not match the durable start",
				);
		} else if (lease.bootstrapReceipt.kind !== "automatic")
			return reject("worker_receipt_invalid", "Automatic start requires an automatic receipt");
		const parent = start.recoveryTurnRecordId
			? ctx.deps.turnRecords.getById(start.recoveryTurnRecordId)
			: null;
		const prepared =
			lease.bootstrapReceipt.kind === "llm" ? lease.bootstrapReceipt.preparedStart : null;
		const acceptedLlmStart = start.state.start.kind === "llm" ? start.state.start : null;
		return accept({
			writes: {
				...(start.startKind === "continue"
					? {
							processPatch: { metadata: metadataAfterAcceptedContinue(ctx.process.metadata) },
							changedFields: ["metadata"],
						}
					: {}),
				turnRecordWrites: [
					{
						kind: "create",
						input: {
							id: start.proposedTurnRecordId,
							instanceId: start.instanceId,
							turnId: start.turnId,
							turnType: start.turnType,
							status: "running",
							attemptNumber: (parent?.attemptNumber ?? 0) + 1,
							parentTurnRecordId: start.recoveryTurnRecordId,
							pathType: prepared?.pathType ?? "primary",
							forkPiEntryId: prepared?.forkPiEntryId ?? null,
							turnStartRecordId: start.id,
							acceptedWorkerLeaseId: lease.id,
							modelProfileId: acceptedLlmStart?.model.profileId ?? null,
							modelSelectionProvenance: acceptedLlmStart?.modelSelectionProvenance ?? null,
						},
					},
				],
				turnStartWrites: [
					{
						kind: "cas_state",
						id: start.id,
						expectedKind: "starting",
						state: {
							kind: "accepted",
							start: start.state.start,
							turnRecordId: start.proposedTurnRecordId,
							acceptedWorkerLeaseId: lease.id,
						},
					},
				],
			},
			data: { turnRecordId: start.proposedTurnRecordId },
		});
	},
});

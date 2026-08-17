import {
	type ProcessInstance,
	type ProcessTurnRecord,
	parseProcessStateJsonLenient,
	type TurnOutcomePayload,
} from "@leitwerk-dev/domain";
import {
	isAutomaticTurnDefinition,
	isLlmTurnDefinition,
	isServerAutomaticTurnDefinition,
	parseStructuralProcessState,
} from "@leitwerk-dev/process-sdk";
import { validateTurnOutcomeCorrelation } from "../../domain-logic/turn-record-guards.js";
import { captureLeafOutcomeSnapshot } from "../../leaf-outcome-snapshot-capture.js";
import { buildTurnOutcomeWrites } from "../../process-engine/writes/build-turn-outcome-writes.js";
import {
	applyProcessPatchField,
	createWrites,
	isWriteBuildFailure,
	mergeWrites,
	type WriteBuildFailure,
} from "../../process-engine/writes/writes.js";
import { getProcessTurnGraph } from "../../process-graph.js";
import {
	deriveTurnOutcomeProductRefPatch,
	mergeProductRefPatchIntoStateJson,
	type ProcessProductRefPatch,
} from "../../product-ref-state.js";
import {
	deriveTurnOutcomeSemanticEntryRefPatch,
	mergeSemanticEntryRefPatchIntoStateJson,
	type ProcessSemanticEntryRefPatch,
} from "../../semantic-entry-ref-state.js";
import { accept, reject } from "../decision.js";
import { defineOperation } from "../operation.js";

export interface TurnOutcomeInput {
	instanceId: string;
	payload: TurnOutcomePayload;
	onRecorded?: () => void;
}

function applySemanticEntryRefPatch(
	baseStateJson: string | null | undefined,
	patch: ProcessSemanticEntryRefPatch,
	options: { fallbackStateJson?: string | null | undefined } = {},
): string | null {
	return mergeSemanticEntryRefPatchIntoStateJson(baseStateJson, patch, options);
}

function applyProductRefPatch(
	baseStateJson: string | null | undefined,
	patch: ProcessProductRefPatch,
	options: { fallbackStateJson?: string | null | undefined } = {},
): string | null {
	return mergeProductRefPatchIntoStateJson(baseStateJson, patch, options);
}

function sameEntryRef(
	left: { entryId: string; turnRecordId: string | null } | null | undefined,
	right: { entryId: string; turnRecordId: string | null } | null | undefined,
): boolean {
	return (
		(left?.entryId ?? null) === (right?.entryId ?? null) &&
		(left?.turnRecordId ?? null) === (right?.turnRecordId ?? null)
	);
}

function writeBuildFailure(code: string, message: string): WriteBuildFailure {
	return { ok: false, code, message };
}

function validateRequiredTurnResultMarkdown(input: {
	payload: TurnOutcomePayload;
	required: boolean;
}): WriteBuildFailure | null {
	if (!input.required) {
		return null;
	}
	if (
		typeof input.payload.turnResultMarkdown !== "string" ||
		input.payload.turnResultMarkdown.trim() === ""
	) {
		return writeBuildFailure(
			"turn_result_markdown_missing",
			`Turn '${input.payload.turnId}' requires non-empty turn-result markdown`,
		);
	}
	return null;
}

function validatePublishedProductOutcome(input: {
	process: Pick<ProcessInstance, "id" | "processId">;
	payload: TurnOutcomePayload;
	publishedProduct: string | null;
}): WriteBuildFailure | null {
	if (!input.publishedProduct) {
		return null;
	}
	const resultPiEntryId = input.payload.resultPiEntryId?.trim();
	if (!resultPiEntryId) {
		return writeBuildFailure(
			"published_product_result_entry_missing",
			`Turn '${input.payload.turnId}' publishes product '${input.publishedProduct}' but did not report a result entry`,
		);
	}
	if (
		typeof input.payload.turnResultMarkdown !== "string" ||
		input.payload.turnResultMarkdown.trim() === ""
	) {
		return writeBuildFailure(
			"published_product_markdown_missing",
			`Turn '${input.payload.turnId}' publishes product '${input.publishedProduct}' but did not report non-empty turn-result markdown`,
		);
	}
	return null;
}

function resolveOutcomePublication(input: {
	processGraphs: TurnOutcomeContextProcessGraphs;
	processId: string;
	turnId: string;
	outcome: string;
	turnPublishedProduct: string | null;
}): { productName: string | null; markdownParameterName: string | null } {
	const definition = input.processGraphs.get(input.processId)?.turns.get(input.turnId)?.definition;
	if (
		!definition ||
		(!isLlmTurnDefinition(definition) &&
			!isAutomaticTurnDefinition(definition) &&
			!isServerAutomaticTurnDefinition(definition))
	) {
		return { productName: input.turnPublishedProduct, markdownParameterName: null };
	}
	const outcome = definition.outcomes?.[input.outcome];
	return {
		productName: outcome?.publishedProduct ?? input.turnPublishedProduct,
		markdownParameterName: outcome?.turnResultMarkdownParameter ?? null,
	};
}

function resolveEffectiveOutcomePayload(input: {
	payload: TurnOutcomePayload;
	publication: { productName: string | null; markdownParameterName: string | null };
}): TurnOutcomePayload {
	let turnResultMarkdown = input.payload.turnResultMarkdown;
	if (
		(typeof turnResultMarkdown !== "string" || turnResultMarkdown.trim() === "") &&
		input.publication.markdownParameterName
	) {
		const value = input.payload.params[input.publication.markdownParameterName];
		if (typeof value === "string" && value.trim() !== "") {
			turnResultMarkdown = value;
		}
	}
	let resultPiEntryId = input.payload.resultPiEntryId;
	if (
		input.publication.productName &&
		(typeof resultPiEntryId !== "string" || resultPiEntryId.trim() === "") &&
		(input.payload.turnType === "automatic" || input.payload.turnType === "server_automatic")
	) {
		resultPiEntryId = `${input.payload.turnType}:${input.payload.turnRecordId}:${input.publication.productName}`;
	}
	return {
		...input.payload,
		...(turnResultMarkdown !== input.payload.turnResultMarkdown ? { turnResultMarkdown } : {}),
		...(resultPiEntryId !== input.payload.resultPiEntryId ? { resultPiEntryId } : {}),
	};
}

type TurnOutcomeContextProcessGraphs = Parameters<typeof getProcessTurnGraph>[0];

export const TurnOutcome = defineOperation<"turn_outcome", TurnOutcomeInput, void>({
	kind: "turn_outcome",
	label: "Turn outcome",
	afterRecord(input) {
		input.onRecorded?.();
	},
	async decide(ctx, input) {
		const initialPayload = input.payload;
		const turnGraph = getProcessTurnGraph(
			ctx.deps.processGraphs,
			ctx.process.processId,
			initialPayload.turnId,
		);
		const resultSemanticRef = turnGraph?.resultSemanticRef ?? null;
		const publication = resolveOutcomePublication({
			processGraphs: ctx.deps.processGraphs,
			processId: ctx.process.processId,
			turnId: initialPayload.turnId,
			outcome: initialPayload.outcome,
			turnPublishedProduct: turnGraph?.publishedProduct ?? null,
		});
		const payload = resolveEffectiveOutcomePayload({ payload: initialPayload, publication });
		const publishedProduct = publication.productName;
		const expected =
			ctx.process.currentExecution?.kind === "worker_start"
				? (() => {
						const state = ctx.deps.turnStarts.getById(ctx.process.currentExecution.id)?.state;
						return state?.kind === "accepted" ? state.turnRecordId : null;
					})()
				: ctx.process.currentExecution?.kind === "server_turn"
					? ctx.process.currentExecution.id
					: null;
		const correlationError = validateTurnOutcomeCorrelation(ctx.process, payload, expected);
		if (correlationError) {
			return reject(correlationError.code, correlationError.message);
		}
		const requiredMarkdownError = validateRequiredTurnResultMarkdown({
			payload,
			required: turnGraph?.turnResultMarkdownRequired === true,
		});
		if (requiredMarkdownError) {
			return reject(requiredMarkdownError.code, requiredMarkdownError.message);
		}
		const publishedProductError = validatePublishedProductOutcome({
			process: ctx.process,
			payload,
			publishedProduct,
		});
		if (publishedProductError) {
			return reject(publishedProductError.code, publishedProductError.message);
		}

		const processActionRegistry = ctx.deps.getProcessActionRegistry?.();
		if (!processActionRegistry) {
			return reject(
				"registry_not_ready",
				`Turn outcome handlers are not available for process '${ctx.process.processId}'`,
			);
		}
		const processUiRegistry = ctx.deps.getProcessUiRegistry?.();
		const projects = ctx.deps.projects.listByInstance(input.instanceId);
		const recordedAt = new Date().toISOString();
		const baseWrites = createWrites();
		const milestoneAnnotationKey = `turn_milestone:${payload.turnRecordId}`;
		const milestoneReferences = [
			{ kind: "turn_record" as const, turnRecordId: payload.turnRecordId, role: "subject" },
			...(payload.resultPiEntryId
				? [
						{
							kind: "entry" as const,
							entryId: payload.resultPiEntryId,
							role: "subject",
						},
					]
				: []),
		];
		const milestonePayload = {
			turnId: payload.turnId,
			turnType: payload.turnType ?? "llm",
			pathType: payload.pathType ?? "primary",
			outcome: payload.outcome,
			...(resultSemanticRef ? { resultSemanticRef } : {}),
		};
		const existingMilestone = ctx.deps.turnAnnotations.findByKey(
			input.instanceId,
			milestoneAnnotationKey,
		);
		if (existingMilestone) {
			baseWrites.turnAnnotationWrites.push({
				kind: "update",
				id: existingMilestone.id,
				input: {
					annotationType: "turn_milestone",
					annotationKey: milestoneAnnotationKey,
					references: milestoneReferences,
					payload: milestonePayload,
				},
			});
		} else {
			baseWrites.turnAnnotationWrites.push({
				kind: "create",
				input: {
					instanceId: input.instanceId,
					annotationType: "turn_milestone",
					annotationKey: milestoneAnnotationKey,
					references: milestoneReferences,
					payload: milestonePayload,
				},
			});
		}
		const existing = ctx.deps.turnRecords.getById(payload.turnRecordId);
		const completedTurnRecord: ProcessTurnRecord = existing
			? {
					...existing,
					turnType: payload.turnType ?? existing.turnType,
					status: "succeeded" as const,
					resultPiEntryId: payload.resultPiEntryId ?? null,
					modelProfileId: existing.modelProfileId,
					turnResultMarkdown: payload.turnResultMarkdown ?? null,
					endedAt: recordedAt,
					errorSummary: null,
					errorClass: null,
				}
			: {
					id: payload.turnRecordId,
					instanceId: input.instanceId,
					turnId: payload.turnId,
					turnType: payload.turnType,
					status: "succeeded",
					attemptNumber: 1,
					parentTurnRecordId: null,
					pathType: payload.pathType ?? "primary",
					forkPiEntryId: payload.forkPiEntryId ?? null,
					resultPiEntryId: payload.resultPiEntryId ?? null,
					modelProfileId: null,
					turnResultMarkdown: payload.turnResultMarkdown ?? null,
					errorSummary: null,
					errorClass: null,
					startedAt: recordedAt,
					endedAt: recordedAt,
				};
		if (existing) {
			baseWrites.turnRecordWrites.push({
				kind: "update",
				id: payload.turnRecordId,
				input: {
					turnType: payload.turnType,
					status: "succeeded",
					resultPiEntryId: payload.resultPiEntryId ?? null,
					turnResultMarkdown: payload.turnResultMarkdown ?? null,
					endedAt: recordedAt,
				},
			});
		} else {
			baseWrites.turnRecordWrites.push({
				kind: "create",
				input: {
					id: completedTurnRecord.id,
					instanceId: completedTurnRecord.instanceId,
					turnId: completedTurnRecord.turnId,
					turnType: completedTurnRecord.turnType,
					status: completedTurnRecord.status,
					attemptNumber: completedTurnRecord.attemptNumber,
					parentTurnRecordId: completedTurnRecord.parentTurnRecordId,
					pathType: completedTurnRecord.pathType,
					forkPiEntryId: completedTurnRecord.forkPiEntryId,
					resultPiEntryId: completedTurnRecord.resultPiEntryId,
					...(completedTurnRecord.modelProfileId !== null
						? { modelProfileId: completedTurnRecord.modelProfileId }
						: {}),
					turnResultMarkdown: completedTurnRecord.turnResultMarkdown,
					errorSummary: completedTurnRecord.errorSummary,
					errorClass: completedTurnRecord.errorClass,
					startedAt: completedTurnRecord.startedAt,
					endedAt: completedTurnRecord.endedAt,
				},
			});
		}
		applyProcessPatchField(baseWrites, ctx.process, "currentExecution", null);
		if (ctx.process.lifecycleStatus === "error") {
			applyProcessPatchField(baseWrites, ctx.process, "lifecycleStatus", "active");
		}

		const candidateProcess = { ...ctx.process, ...baseWrites.processPatch };
		const outcomeWrites = await buildTurnOutcomeWrites({
			process: candidateProcess,
			projects,
			payload,
			turnRecords: ctx.deps.turnRecords,
			processGraphs: ctx.deps.processGraphs,
			processActionRegistry,
		});
		if (isWriteBuildFailure(outcomeWrites)) {
			return reject(outcomeWrites.code, outcomeWrites.message);
		}

		const mergedWrites = mergeWrites(baseWrites, outcomeWrites);
		const semanticEntryRefPatch = deriveTurnOutcomeSemanticEntryRefPatch({
			turnRecordId: payload.turnRecordId,
			resultSemanticRef,
			pathType: payload.pathType ?? "primary",
			resultPiEntryId: payload.resultPiEntryId ?? null,
			rootEntryId: payload.rootEntryId,
		});
		const productRefPatch = deriveTurnOutcomeProductRefPatch({
			turnRecordId: payload.turnRecordId,
			publishedProduct,
			resultPiEntryId: payload.resultPiEntryId ?? null,
		});
		const semanticStateJson = applySemanticEntryRefPatch(
			mergedWrites.processPatch.stateJson ?? ctx.process.stateJson,
			semanticEntryRefPatch,
			{ fallbackStateJson: ctx.process.stateJson },
		);
		const productStateJson = applyProductRefPatch(
			semanticStateJson ?? mergedWrites.processPatch.stateJson ?? ctx.process.stateJson,
			productRefPatch,
			{ fallbackStateJson: ctx.process.stateJson },
		);
		const nextStateJson = productStateJson ?? semanticStateJson;
		if (nextStateJson !== null) {
			applyProcessPatchField(
				mergedWrites,
				{ stateJson: mergedWrites.processPatch.stateJson ?? ctx.process.stateJson },
				"stateJson",
				nextStateJson,
			);
		}

		const previousState = parseStructuralProcessState(
			parseProcessStateJsonLenient(ctx.process.stateJson),
		);
		const nextState = parseStructuralProcessState(
			parseProcessStateJsonLenient(mergedWrites.processPatch.stateJson ?? ctx.process.stateJson),
		);
		const previousSemanticEntryRefs = previousState.semanticEntryRefs;
		const nextSemanticEntryRefs = nextState.semanticEntryRefs;
		const previousPrimaryLeaf = previousSemanticEntryRefs.currentPrimaryPathLeaf;
		const nextPrimaryLeaf = nextSemanticEntryRefs.currentPrimaryPathLeaf;
		const previousResultSemanticRef = resultSemanticRef
			? previousSemanticEntryRefs[resultSemanticRef]
			: null;
		const nextResultSemanticRef = resultSemanticRef
			? nextSemanticEntryRefs[resultSemanticRef]
			: null;
		const automaticLeafOutcomeCaptureTarget =
			payload.turnType === "automatic"
				? {
						entryId: `automatic:${payload.turnRecordId}`,
						turnRecordId: payload.turnRecordId,
					}
				: null;
		const leafOutcomeCaptureTarget =
			processUiRegistry && ctx.deps.sessionReader
				? (payload.pathType ?? "primary") === "primary" &&
					nextPrimaryLeaf &&
					!sameEntryRef(previousPrimaryLeaf, nextPrimaryLeaf) &&
					ctx.deps.leafOutcomeSnapshots.getByInstanceAndLeafEntryId(
						input.instanceId,
						nextPrimaryLeaf.entryId,
					) === null
					? nextPrimaryLeaf
					: resultSemanticRef &&
							nextResultSemanticRef &&
							!sameEntryRef(previousResultSemanticRef, nextResultSemanticRef) &&
							ctx.deps.leafOutcomeSnapshots.getByInstanceAndLeafEntryId(
								input.instanceId,
								nextResultSemanticRef.entryId,
							) === null
						? nextResultSemanticRef
						: automaticLeafOutcomeCaptureTarget &&
								ctx.deps.leafOutcomeSnapshots.getByInstanceAndLeafEntryId(
									input.instanceId,
									automaticLeafOutcomeCaptureTarget.entryId,
								) === null
							? automaticLeafOutcomeCaptureTarget
							: null
				: null;
		if (leafOutcomeCaptureTarget && processUiRegistry && ctx.deps.sessionReader) {
			const capturedProcess = {
				...ctx.process,
				...mergedWrites.processPatch,
				stateJson: mergedWrites.processPatch.stateJson ?? ctx.process.stateJson,
			};
			const snapshotInput = await captureLeafOutcomeSnapshot({
				process: capturedProcess,
				projects,
				processActionRegistry,
				processUiRegistry,
				turnRecords: ctx.deps.turnRecords,
				sessionReader: ctx.deps.sessionReader,
				leaf: leafOutcomeCaptureTarget,
				turnRecord: completedTurnRecord,
				anchoredAt: completedTurnRecord.endedAt ?? recordedAt,
			});
			if (snapshotInput) {
				mergedWrites.leafOutcomeSnapshotWrites.push({
					kind: "create",
					input: snapshotInput,
				});
			}
		}

		return accept({ writes: mergedWrites });
	},
});

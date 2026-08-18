import type { Actor } from "@leitwerk-dev/domain";
import { isProcessTurnType, SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import {
	isLlmTurnDefinition,
	type ProcessActionDefinition,
	type ProcessActionExecutionOrigin,
	type ProcessActionExecutionSource,
} from "@leitwerk-dev/process-sdk";
import { generateId, now } from "../../db/repo-helpers.js";
import { evaluateScheduledActionLock } from "../../domain-logic/scheduled-action-lock.js";
import { planConsumeFutureExecution } from "../../future-execution/transition-planner.js";
import { planProcessAction } from "../../process-action-planner.js";
import { presentProcessModelPolicyFailure } from "../../process-model-policy-presenter.js";
import { mergeProductRefPatchIntoStateJson } from "../../product-ref-state.js";
import { accept, reject } from "../decision.js";
import { defineOperation } from "../operation.js";
import {
	appendProcessEvent,
	applyProcessPatchField,
	stampActorOnQueuedInputs,
} from "../writes/writes.js";

const DEFAULT_ACTION_ORIGIN_BY_SOURCE: Record<
	ProcessActionExecutionSource,
	ProcessActionExecutionOrigin
> = {
	ui: "web_ui",
	external: "external_interface",
	scheduled: "scheduled",
};

export interface ExecuteActionInput {
	instanceId: string;
	actionId: string;
	input: Record<string, unknown>;
	opts?: {
		nextTurnModelProfileId?: string | null;
		source?: ProcessActionExecutionSource;
		origin?: ProcessActionExecutionOrigin;
		scheduledExecutionId?: string;
		consumeScheduledExecutionOnSuccess?: boolean;
		actor?: Actor;
	};
}

function latestLlmSourceTurnRecordId(
	records: readonly {
		id: string;
		turnType: string;
		status: string;
		startedAt: string;
	}[],
): string | null {
	return (
		[...records]
			.filter((record) => record.turnType === "llm" && record.status === "succeeded")
			.sort(
				(left, right) =>
					left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
			)
			.at(-1)?.id ?? null
	);
}

function stringifySubmittedFieldValue(value: unknown): string {
	if (typeof value === "string") {
		return value.trim();
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value
			.map((entry) => stringifySubmittedFieldValue(entry))
			.filter((entry) => entry.length > 0)
			.join(", ")
			.trim();
	}
	return "";
}

function buildSubmittedActionFields(
	action: {
		form?: {
			fields: ReadonlyArray<{ id: string; label: string }>;
		};
	},
	input: Record<string, unknown>,
): Array<{ fieldId: string; label: string; value: string }> {
	const submittedFields: Array<{ fieldId: string; label: string; value: string }> = [];
	const seenFieldIds = new Set<string>();

	for (const field of action.form?.fields ?? []) {
		seenFieldIds.add(field.id);
		const value = stringifySubmittedFieldValue(input[field.id]);
		if (!value) {
			continue;
		}
		submittedFields.push({ fieldId: field.id, label: field.label, value });
	}

	for (const [fieldId, rawValue] of Object.entries(input)) {
		if (seenFieldIds.has(fieldId)) {
			continue;
		}
		const value = stringifySubmittedFieldValue(rawValue);
		if (!value) {
			continue;
		}
		submittedFields.push({ fieldId, label: fieldId, value });
	}

	return submittedFields;
}

function resolvePublishedFormField(
	action: ProcessActionDefinition,
	input: Record<string, unknown>,
): { productName: string; markdown: string } | null {
	const publishedFields = (action.form?.fields ?? []).filter((field) => field.publish);
	if (publishedFields.length === 0) {
		return null;
	}
	if (publishedFields.length > 1) {
		throw new Error("Actions may publish at most one form field in flow v1");
	}
	const field = publishedFields[0];
	if (!field) {
		return null;
	}
	const markdown = stringifySubmittedFieldValue(input[field.id]);
	if (!markdown) {
		return null;
	}
	return {
		productName:
			typeof field.publish === "object" && field.publish.product ? field.publish.product : field.id,
		markdown,
	};
}

export const ExecuteAction = defineOperation<
	"execute_action",
	ExecuteActionInput,
	Record<string, unknown>
>({
	kind: "execute_action",
	label: "Execute process action",
	reportBestEffortFailures: (input) => input.opts?.source === "scheduled",
	async decide(ctx, input) {
		const actionSource = input.opts?.source ?? "ui";
		const actionOrigin = input.opts?.origin ?? DEFAULT_ACTION_ORIGIN_BY_SOURCE[actionSource];
		const actor = input.opts?.actor ?? SYSTEM_ACTOR;
		const scheduledAction = ctx.deps.futureExecutions.getScheduledActionByInstance(
			input.instanceId,
		);
		const scheduledActionLock = evaluateScheduledActionLock({
			scheduledAction,
			actionSource,
			scheduledExecutionId: input.opts?.scheduledExecutionId,
		});
		if (!scheduledActionLock.ok) {
			return reject(scheduledActionLock.code, scheduledActionLock.error);
		}

		const registry = ctx.deps.getProcessActionRegistry?.();
		if (!registry) {
			return reject("registry_not_ready", "Action registry not ready");
		}
		const projects = ctx.deps.projects.listByInstance(input.instanceId);
		const plannedAction = await planProcessAction({
			processGraphs: ctx.deps.processGraphs,
			processActionRegistry: registry,
			process: ctx.process,
			projects,
			turnRecords: ctx.deps.turnRecords,
			actionId: input.actionId,
			actionInput: input.input,
			actionSource,
		});
		if (!plannedAction.ok) {
			return reject(plannedAction.code, plannedAction.error);
		}
		const { action, actionLabel, writes, resolvedTurnAction } = plannedAction;
		const candidateSelectedTurnId = plannedAction.candidateSelectedTurnId;
		const candidateTurnDef = candidateSelectedTurnId
			? registry.getTurnDefinition(ctx.process.processId, candidateSelectedTurnId)
			: undefined;
		const causedSelectedTurnId =
			candidateSelectedTurnId && candidateSelectedTurnId !== ctx.process.selectedTurnId
				? candidateSelectedTurnId
				: null;
		const causedSelectedTurnType =
			causedSelectedTurnId && isProcessTurnType(candidateTurnDef?.kind)
				? candidateTurnDef.kind
				: null;
		let publishedFormField: { productName: string; markdown: string } | null = null;
		try {
			publishedFormField = resolvePublishedFormField(action, input.input);
		} catch (error) {
			return reject("action_failed", error instanceof Error ? error.message : String(error));
		}

		if (input.opts?.nextTurnModelProfileId !== undefined) {
			if (!action.plan) {
				return reject(
					"action_failed",
					"Next-turn model override is only available for actions that declare plan(...)",
				);
			}
			if (!candidateTurnDef || !isLlmTurnDefinition(candidateTurnDef)) {
				return reject(
					"action_failed",
					"Next-turn model override is only available when the action selects an LLM turn",
				);
			}
			if (input.opts.nextTurnModelProfileId !== null) {
				const evaluation = ctx.deps.processModelPolicy.evaluate({
					kind: "runtime_selection",
					availability: ctx.deps.getModelAvailabilitySnapshot(),
					processId: ctx.process.processId,
					selection: {
						modelProfileId: input.opts.nextTurnModelProfileId,
						provenance: { kind: "explicit", source: "action_override" },
					},
				});
				if (!evaluation.ok) {
					return reject("invalid_model_profile", presentProcessModelPolicyFailure(evaluation));
				}
			}
		}

		const submittedFields = buildSubmittedActionFields(action, input.input);
		const sourceTurnRecordId = resolvedTurnAction
			? latestLlmSourceTurnRecordId(ctx.deps.turnRecords.listByInstance(input.instanceId))
			: null;

		if (resolvedTurnAction) {
			const recordedAt = now();
			const turnRecordId = generateId("trn");
			const publishedResultEntryId = publishedFormField
				? `action:${turnRecordId}:${publishedFormField.productName}`
				: null;
			const annotationType =
				resolvedTurnAction.kind === "ui_human_action" ? "acceptance_state" : "external_trigger";
			writes.turnRecordWrites.push({
				kind: "create",
				input: {
					id: turnRecordId,
					instanceId: input.instanceId,
					turnId: resolvedTurnAction.turnId,
					turnType: resolvedTurnAction.turnType,
					status: "succeeded",
					pathType: "primary",
					...(publishedResultEntryId ? { resultPiEntryId: publishedResultEntryId } : {}),
					...(publishedFormField ? { turnResultMarkdown: publishedFormField.markdown } : {}),
					startedAt: recordedAt,
					endedAt: recordedAt,
				},
			});
			if (publishedFormField && publishedResultEntryId) {
				const patchedStateJson = mergeProductRefPatchIntoStateJson(
					writes.processPatch.stateJson ?? ctx.process.stateJson,
					{
						[publishedFormField.productName]: {
							entryId: publishedResultEntryId,
							turnRecordId,
						},
					},
					{ fallbackStateJson: ctx.process.stateJson },
				);
				if (patchedStateJson !== null) {
					applyProcessPatchField(
						writes,
						{ stateJson: writes.processPatch.stateJson ?? ctx.process.stateJson },
						"stateJson",
						patchedStateJson,
					);
				}
			}
			writes.turnAnnotationWrites.push({
				kind: "create",
				input: {
					instanceId: input.instanceId,
					annotationType,
					annotationKey: `${annotationType}:${turnRecordId}`,
					references: [
						{
							kind: "turn_record" as const,
							turnRecordId,
							role: "subject",
						},
						...(resolvedTurnAction.semanticEntryRefKey
							? [
									{
										kind: "semantic_entry_ref" as const,
										ref: resolvedTurnAction.semanticEntryRefKey,
										role: "related",
									},
								]
							: []),
					],
					payload: {
						turnId: resolvedTurnAction.turnId,
						actionId: input.actionId,
						actionLabel,
						...(sourceTurnRecordId ? { sourceTurnRecordId } : {}),
						selectedTurnId: ctx.process.selectedTurnId,
						selectedTurnIdBefore: ctx.process.selectedTurnId,
						...(causedSelectedTurnId
							? {
									selectedTurnIdAfter: causedSelectedTurnId,
									causedSelectedTurnId,
									...(causedSelectedTurnType ? { causedSelectedTurnType } : {}),
								}
							: {}),
						actionSource,
						...(resolvedTurnAction.kind === "ui_human_action"
							? { acceptanceState: resolvedTurnAction.acceptanceState }
							: {
									triggerId: resolvedTurnAction.externalTrigger.id,
									triggerLabel: resolvedTurnAction.externalTrigger.label,
									triggerDescription: resolvedTurnAction.externalTrigger.description,
									...(resolvedTurnAction.kind === "external_human_trigger"
										? { acceptanceState: resolvedTurnAction.acceptanceState }
										: {}),
								}),
						actionOrigin,
						actor,
						...(submittedFields.length > 0 ? { submittedFields } : {}),
					},
					createdAt: recordedAt,
					updatedAt: recordedAt,
				},
			});
		}

		appendProcessEvent(writes, ctx.process, {
			eventType: "process_action_executed",
			level: "info",
			message: `Action ${actionLabel} executed`,
			data: {
				actionId: input.actionId,
				actionLabel,
				actionSource,
				actionOrigin,
				actor,
			},
		});

		// Action-originated follow-up prompts inherit the actor that triggered the action.
		stampActorOnQueuedInputs(writes, actor);

		const metadata =
			input.opts?.nextTurnModelProfileId !== undefined
				? { nextTurnModelProfileId: input.opts.nextTurnModelProfileId }
				: undefined;
		if (
			input.opts?.consumeScheduledExecutionOnSuccess === true &&
			typeof input.opts.scheduledExecutionId === "string" &&
			scheduledAction?.id === input.opts.scheduledExecutionId
		) {
			writes.futureExecutionPlans.push(planConsumeFutureExecution(scheduledAction));
			writes.broadcasts.push({
				type: "future.updated",
				payload: {
					futureExecutionId: scheduledAction.id,
					operation: "deleted",
					kind: scheduledAction.kind,
				},
				...(scheduledAction.instanceId ? { instanceId: scheduledAction.instanceId } : {}),
			});
		}

		return accept<Record<string, unknown>>({
			writes,
			data: {},
			...(metadata ? { metadata } : {}),
		});
	},
});

import type { ProcessInstance } from "@leitwerk-dev/domain";
import { isLlmTurnDefinition, type TurnDefinition } from "@leitwerk-dev/process-sdk";
import type {
	ProcessActionPreviewSummary,
	ProcessActionSummary,
} from "@leitwerk-dev/protocol/http-contracts";
import type { VisibleProcessActionSummary } from "./process-action-registry.js";
import {
	listVisibleActionsForProcess as listVisibleAttentionActionsForProcess,
	type ProcessOperatorAttentionDeps,
} from "./process-operator-attention.js";

/** @internal */
export function buildActionSummaryForProcess(
	deps: Pick<ProcessOperatorAttentionDeps, "processActionRegistry">,
	process: ProcessInstance,
	action: Pick<VisibleProcessActionSummary, "id" | "label" | "form"> &
		Partial<Pick<VisibleProcessActionSummary, "description" | "preview">> & {
			supportsScheduling?: boolean;
		},
): ProcessActionSummary {
	const actionId = action.id;
	const preview =
		action.preview ??
		deps.processActionRegistry?.resolveActionPreview(process.processId, process, actionId) ??
		null;
	const hasPurePlan =
		typeof deps.processActionRegistry?.getAction(process.processId, actionId)?.plan === "function";
	const turnDef = preview?.candidateSelectedTurnId
		? deps.processActionRegistry?.getTurnDefinition(
				process.processId,
				preview.candidateSelectedTurnId,
			)
		: undefined;
	const supportsScheduling =
		action.supportsScheduling ??
		Boolean(
			hasPurePlan &&
				deps.processActionRegistry?.resolveActionScheduling(process.processId, process, actionId),
		);
	return {
		id: action.id,
		label: action.label,
		description: action.description ?? null,
		preview: buildProcessActionPreviewSummary(preview, turnDef),
		supportsScheduling,
		supportsNextTurnModelOverride: Boolean(hasPurePlan && turnDef && isLlmTurnDefinition(turnDef)),
		...(action.form
			? {
					form: {
						id: action.form.id,
						title: action.form.title,
						submitLabel: action.form.submitLabel,
						fields: action.form.fields.map((field) => ({ ...field })),
					},
				}
			: {}),
	};
}

/** @internal */
export function listVisibleActionsForProcess(
	deps: ProcessOperatorAttentionDeps,
	process: ProcessInstance,
) {
	return listVisibleAttentionActionsForProcess(deps, process).map((action) =>
		buildActionSummaryForProcess(deps, process, action),
	);
}

function buildProcessActionPreviewSummary(
	preview: {
		candidateSelectedTurnId: string | null;
		lifecycleStatus?: string | null;
	} | null,
	turnDef: TurnDefinition | undefined,
): ProcessActionPreviewSummary | null {
	if (!preview) {
		return null;
	}
	if (!preview.candidateSelectedTurnId) {
		return {
			kind: "terminal",
			turnId: null,
			turnKind: null,
			description: preview.lifecycleStatus === "aborted" ? "Abort process" : "Complete process",
		};
	}
	if (!turnDef) {
		return null;
	}
	return {
		kind: "turn",
		turnId: preview.candidateSelectedTurnId,
		turnKind: turnDef.kind,
		description: turnDef.description,
	};
}

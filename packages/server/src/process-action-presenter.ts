import type { ProcessInstance } from "@leitwerk-dev/domain";
import { type FormDefinition, isLlmTurnDefinition } from "@leitwerk-dev/process-sdk";
import type {
	ProcessActionPreviewSummary,
	ProcessActionSummary,
} from "@leitwerk-dev/protocol/http-contracts";
import type { VisibleProcessActionSummary } from "./process-action-registry.js";
import {
	listVisibleActionsForProcess as listVisibleAttentionActionsForProcess,
	type ProcessOperatorAttentionDeps,
} from "./process-operator-attention.js";

function actionHasPurePlan(
	deps: Pick<ProcessOperatorAttentionDeps, "processActionRegistry">,
	process: ProcessInstance,
	actionId: string,
): boolean {
	const action = deps.processActionRegistry?.getAction(process.processId, actionId);
	return typeof action?.plan === "function";
}

/** @internal */
export function buildActionSummaryForProcess(
	deps: Pick<ProcessOperatorAttentionDeps, "processActionRegistry">,
	process: ProcessInstance,
	action: {
		id: string;
		label: string;
		form?: FormDefinition;
	},
	visibleAction?: VisibleProcessActionSummary,
	labelOverride?: string | null,
	overrides: { supportsScheduling?: boolean } = {},
): ProcessActionSummary {
	const actionId = action.id;
	const preview =
		visibleAction?.preview ??
		deps.processActionRegistry?.resolveActionPreview(process.processId, process, actionId) ??
		null;
	const supportsScheduling =
		overrides.supportsScheduling ??
		Boolean(
			actionHasPurePlan(deps, process, actionId) &&
				deps.processActionRegistry?.resolveActionScheduling(process.processId, process, actionId),
		);
	const label = labelOverride ?? visibleAction?.label ?? action.label;
	return {
		id: action.id,
		label: label.trim() ? label : action.label,
		description: visibleAction?.description ?? null,
		preview: buildProcessActionPreviewSummary(deps, preview, process),
		supportsScheduling,
		supportsNextTurnModelOverride: previewSupportsNextTurnModelOverride(
			deps,
			process,
			actionId,
			preview,
		),
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
		buildActionSummaryForProcess(deps, process, action, action, action.label),
	);
}

function buildProcessActionPreviewSummary(
	deps: Pick<ProcessOperatorAttentionDeps, "processActionRegistry">,
	preview: {
		candidateSelectedTurnId: string | null;
		lifecycleStatus?: string | null;
	} | null,
	process: ProcessInstance,
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
	const turnDef = deps.processActionRegistry?.getTurnDefinition(
		process.processId,
		preview.candidateSelectedTurnId,
	);
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

function previewSupportsNextTurnModelOverride(
	deps: Pick<ProcessOperatorAttentionDeps, "processActionRegistry">,
	process: ProcessInstance,
	actionId: string,
	preview: { candidateSelectedTurnId: string | null } | null,
): boolean {
	if (!preview?.candidateSelectedTurnId) {
		return false;
	}
	if (!actionHasPurePlan(deps, process, actionId)) {
		return false;
	}
	const turnDef = deps.processActionRegistry?.getTurnDefinition(
		process.processId,
		preview.candidateSelectedTurnId,
	);
	return Boolean(turnDef && isLlmTurnDefinition(turnDef));
}

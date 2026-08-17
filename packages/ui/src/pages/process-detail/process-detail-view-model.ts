import { describeActionPreview } from "../../chronicle/lib/action-preview.js";
import type {
	ProcessActionSummary,
	ProcessDetailData,
	ProcessExternalTriggerSummary,
} from "../../lib/api.js";

export interface CurrentTurnRecoveryViewModel {
	turnRecordId: string;
	title: string;
	summary: string;
	guidance?: string;
	technicalDetail?: string | null;
	defaultContinuePrompt: string;
	canContinue: boolean;
	supportsModelOverride: boolean;
	defaultModelProfileId: string | null;
	providerOptions: Record<string, string>;
}

export interface CurrentProcessErrorViewModel {
	title: string;
	summary: string;
	guidance?: string;
	technicalDetail?: string | null;
}

export interface PendingRailItemViewModel {
	label: string;
	title: string;
	detail: string | null;
	anchorId?: string;
	tone: "operator_decision" | "scheduled_action" | "error_recovery" | "external_trigger";
	markerText?: string;
	relatedTurnRecordId?: string;
}

export function describePendingActionDetail(
	action: ProcessActionSummary,
	fallbackLabel: string,
): string {
	const preview = describeActionPreview(action);
	return preview ? `${fallbackLabel} → ${preview}` : fallbackLabel;
}

export function buildPendingRailItem(input: {
	scheduledActionDetail: ProcessDetailData["scheduledAction"] | null;
	editingScheduledActionId: string | null;
	currentTurnRecovery: CurrentTurnRecoveryViewModel | null;
	currentProcessError: CurrentProcessErrorViewModel | null;
	availableActions: readonly ProcessActionSummary[];
	visibleExternalTriggers: readonly ProcessExternalTriggerSummary[];
	selectedTurnDescription: string | null;
	actionSectionAnchorId: string;
	processErrorSectionAnchorId: string;
}): PendingRailItemViewModel | null {
	const {
		scheduledActionDetail,
		editingScheduledActionId,
		currentTurnRecovery,
		currentProcessError,
		availableActions,
		visibleExternalTriggers,
		selectedTurnDescription,
		actionSectionAnchorId,
		processErrorSectionAnchorId,
	} = input;
	if (scheduledActionDetail) {
		if (editingScheduledActionId === scheduledActionDetail.id) {
			return {
				label: "Operator decision",
				title: "Decide what happens next",
				detail:
					selectedTurnDescription ??
					describePendingActionDetail(
						scheduledActionDetail.action,
						scheduledActionDetail.actionLabel,
					),
				tone: "operator_decision",
			};
		}
		return {
			label: "Scheduled action",
			title: "Scheduled next step",
			detail: describePendingActionDetail(
				scheduledActionDetail.action,
				scheduledActionDetail.actionLabel,
			),
			tone: "scheduled_action",
			markerText: "⏱",
		};
	}
	if (currentTurnRecovery) {
		return {
			label: "Current turn",
			title: currentTurnRecovery.title,
			detail: currentTurnRecovery.summary,
			anchorId: actionSectionAnchorId,
			tone: "error_recovery",
			markerText: "!",
			relatedTurnRecordId: currentTurnRecovery.turnRecordId,
		};
	}
	if (currentProcessError) {
		return {
			label: "Process issue",
			title: currentProcessError.title,
			detail: currentProcessError.summary,
			anchorId: processErrorSectionAnchorId,
			tone: "error_recovery",
			markerText: "!",
		};
	}
	if (availableActions.length > 0) {
		return {
			label: "Operator decision",
			title: "Decide what happens next",
			detail: selectedTurnDescription,
			tone: "operator_decision",
		};
	}
	if (visibleExternalTriggers.length > 0) {
		return {
			label: "External trigger",
			title: "Waiting for external trigger",
			detail: selectedTurnDescription,
			tone: "external_trigger",
		};
	}
	return null;
}

export function buildJumpToLatestLabel(input: {
	currentTurnRecovery: CurrentTurnRecoveryViewModel | null;
	currentProcessError: CurrentProcessErrorViewModel | null;
	availableActions: readonly ProcessActionSummary[];
	scheduledActionDetail: ProcessDetailData["scheduledAction"] | null;
	hasLiveTail: boolean;
}): string {
	if (input.currentTurnRecovery || input.currentProcessError) {
		return "Jump to current issue";
	}
	if (input.availableActions.length > 0 || input.scheduledActionDetail) {
		return "Decide on next action";
	}
	if (input.hasLiveTail) {
		return "Jump to live turn";
	}
	return "Jump to latest";
}

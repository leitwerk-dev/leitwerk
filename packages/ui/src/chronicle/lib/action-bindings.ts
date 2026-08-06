import type {
	ProcessActionFieldDefinition,
	ProcessActionModelPreview,
	ProcessActionSummary,
} from "../../lib/api.js";

export interface ActionScheduledAtLocalParts {
	date: string;
	hour: string;
	minute: string;
}

export function findQuickActionField(
	action: ProcessActionSummary | null,
): ProcessActionFieldDefinition | null {
	const fields = action?.form?.fields ?? [];
	const field = fields.length === 1 ? fields[0] : null;
	return field && (field.kind === "text" || field.kind === "textarea") ? field : null;
}

export interface ActionSectionController {
	readonly actionSectionActions: readonly ProcessActionSummary[];
	readonly openActionModelPreview: ProcessActionModelPreview | null;
	readonly openActionModelPreviewLoading: boolean;
	readonly actionBusyId: string | null;
	readonly actionError: string | null;
	readonly selectedActionId: string | null;
	readonly openActionFormId: string | null;
	actionFieldDomId: (actionId: string, fieldId: string) => string;
	getActionFieldValue: (
		actionId: string,
		field: ProcessActionFieldDefinition,
	) => string | number | boolean;
	setActionFieldValue: (
		actionId: string,
		field: ProcessActionFieldDefinition,
		value: string | number | boolean,
	) => void;
	commitActionPreview: (actionId: string) => void;
	getActionModelOverrideValue: (actionId: string) => string;
	setActionModelOverrideValue: (actionId: string, value: string) => void;
	getActionScheduleMode: (actionId: string) => "now" | "once";
	setActionScheduleMode: (actionId: string, value: "now" | "once") => void;
	getActionScheduledAtLocalParts: (actionId: string) => ActionScheduledAtLocalParts;
	setActionScheduledAtLocalParts: (
		actionId: string,
		value: Partial<ActionScheduledAtLocalParts>,
	) => void;
	selectAction: (actionId: string) => void;
	expandActionForm: (actionId: string) => void;
	collapseActionForm: () => void;
	submitActionDecision: (action: ProcessActionSummary) => Promise<void> | void;
}

export interface ScheduledActionController {
	readonly scheduledActionBusy: boolean;
	readonly scheduledActionError: string | null;
	editScheduledAction: () => void;
	cancelScheduledAction: () => void;
}

export interface RecoveryController {
	readonly continueBusyTurnRecordId: string | null;
	readonly continueError: { turnRecordId: string; message: string } | null;
	readonly retryBusy: boolean;
	readonly retryError: string | null;
	readonly startupRetryBusy: boolean;
	readonly startupRetryError: string | null;
	continueFailedTurn: (
		turnRecordId: string,
		prompt?: string | null,
		nextTurnModelProfileId?: string | null,
		providerOptions?: Readonly<Record<string, string>>,
	) => Promise<void> | void;
	retryFailedTurn: (
		nextTurnModelProfileId?: string | null,
		providerOptions?: Readonly<Record<string, string>>,
	) => Promise<void> | void;
	retryStartup: (
		startRecordId: string,
		nextTurnModelProfileId?: string | null,
		providerOptions?: Readonly<Record<string, string>>,
	) => Promise<void> | void;
}

export interface LiveTailController {
	readonly abortTurnBusy: boolean;
	readonly abortTurnError: string | null;
	abortRunningTurn: () => Promise<void> | void;
}

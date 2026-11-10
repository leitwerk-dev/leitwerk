import type {
	FormDefinition,
	FormFieldDefinition,
	FormFieldOptionDefinition,
} from "./form-contract.js";

/** @public */
export interface LauncherCardMetadata {
	/** @public */
	title?: string;
	/** @public */
	description?: string;
}

/** @public */
export type LauncherFieldOptionDefinition = FormFieldOptionDefinition;
/** @public */
export type LauncherFieldDefinition = FormFieldDefinition;
/** @public */
export type LauncherSchemaDefinition = FormDefinition<LauncherFieldDefinition>;

/** @public */
export interface LauncherValidationError {
	/** @public */
	code: string;
	/** @public */
	message: string;
	/** @public */
	fieldId?: string;
}

/** Local configuration readiness only; never implies successful external access. @public */
export interface LauncherReadiness {
	/** `partial` is an overview state: some selections remain usable. @public */
	status: "ready" | "partial" | "blocked";
	/** Operator-safe text only. Never include credentials, URLs or raw exceptions. @public */
	issues: readonly LauncherReadinessIssue[];
}

/** @public */
export interface LauncherReadinessIssue {
	/** Stable machine-readable identifier. @public */
	code: string;
	/** Operator-safe explanation. @public */
	summary: string;
	/** Operator-safe corrective action. @public */
	remediation: string;
}

/** @internal */
export interface SkillOptionSummary {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	description: string | null;
}

/** @internal */
export interface SkillSelection {
	/** @internal */
	skillId: string;
	/** @internal */
	revisionId: string;
}

/** @internal */
export interface UiLauncherSummaryBase {
	/** @internal */
	id: string;
	/** @internal */
	processId: string;
	/** @internal */
	displayName: string;
	/** @internal */
	label: string;
	/** @internal */
	description: string;
	/** @internal */
	card: LauncherCardMetadata;
	/** @internal */
	launchConfigSchema: LauncherSchemaDefinition;
	/** Local configuration readiness across available selections. @internal */
	readiness?: LauncherReadiness;
	/** Safe summaries of currently available opt-in skills. @internal */
	skills?: readonly SkillOptionSummary[];
}

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
	/** Safe summaries of currently available opt-in skills. */
	/** @internal */
	skills?: readonly SkillOptionSummary[];
}

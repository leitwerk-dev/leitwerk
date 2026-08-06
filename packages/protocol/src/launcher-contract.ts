import type {
	FormDefinition,
	FormFieldDefinition,
	FormFieldOptionDefinition,
} from "./form-contract.js";

export interface LauncherCardMetadata {
	title?: string;
	description?: string;
}

export type LauncherFieldOptionDefinition = FormFieldOptionDefinition;
export type LauncherFieldDefinition = FormFieldDefinition;
export type LauncherSchemaDefinition = FormDefinition<LauncherFieldDefinition>;

export interface LauncherValidationError {
	code: string;
	message: string;
	fieldId?: string;
}

export interface SkillOptionSummary {
	id: string;
	label: string;
	description: string | null;
}

export interface SkillSelection {
	skillId: string;
	revisionId: string;
}

export interface UiLauncherSummaryBase {
	id: string;
	processId: string;
	displayName: string;
	label: string;
	description: string;
	card: LauncherCardMetadata;
	launchConfigSchema: LauncherSchemaDefinition;
	/** Safe summaries of currently available opt-in skills. */
	skills?: readonly SkillOptionSummary[];
}

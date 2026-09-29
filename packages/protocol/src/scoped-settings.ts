import type { ResolvedSetting, SettingsOverride, SettingsSubject } from "@leitwerk-dev/domain";

/** Serializable metadata shared by extension declarations and operator forms. @public */
export interface SettingMetadata {
	/** Namespaced, for example coding.planning_model. @public */
	key: string;
	/** Increment when stored values cease to satisfy the contract. @public */
	schemaVersion: number;
	/** Least to most specific, including instance where applicable. @public */
	scopes: readonly string[];
	/** @public */
	merge: "replace" | "instructions";
	/** @public */
	form: {
		/** @public */
		label: string;
		/** @public */
		description?: string;
		/** @public */
		group: string;
		/** @public */
		control: "text" | "textarea" | "select" | "model" | "number" | "checkbox" | "multiselect";
	};
}

/** @public */
export interface SettingChoice {
	/** @public */
	value: string;
	/** @public */
	label: string;
	/** @public */
	disabledReason?: string;
}

/** @internal */
export interface SettingFieldView extends SettingMetadata {
	/** @internal */
	owner: string;
	/** @internal */
	choices: readonly SettingChoice[];
	/** @internal */
	effective: ResolvedSetting | null;
	/** @internal */
	inherited: ResolvedSetting | null;
	/** Includes reset revisions. @internal */
	override: SettingsOverride | null;
	/** @internal */
	error: string | null;
}

/** @internal */
export interface SettingsPreview {
	/** @internal */
	subject: SettingsSubject;
	/** @internal */
	fields: SettingFieldView[];
	/** Overrides remain visible while their extension or field is unavailable. @internal */
	inactive: SettingsOverride[];
}

/** @internal */
export interface SettingsScopesResponse {
	/** @internal */
	scopes: Array<{
		/** @internal */
		id: string;
		/** @internal */
		label: string;
	}>;
	/** @internal */
	subjects: Array<
		SettingsSubject & {
			/** @internal */
			active: boolean;
			/** Has declared fields or retained inactive overrides to display. @internal */
			hasSettings: boolean;
		}
	>;
}

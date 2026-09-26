import type { ResolvedSetting, SettingsOverride, SettingsSubject } from "@leitwerk-dev/domain";

/** @internal */
export interface SettingFieldView {
	/** @internal */
	key: string;
	/** @internal */
	owner: string;
	/** @internal */
	schemaVersion: number;
	/** @internal */
	scopes: readonly string[];
	/** @internal */
	merge: "replace" | "instructions";
	/** @internal */
	form: {
		/** @internal */
		label: string;
		/** @internal */
		description?: string;
		/** @internal */
		group: string;
		/** @internal */
		control: "text" | "textarea" | "select" | "model" | "number" | "checkbox";
	};
	/** @internal */
	choices: readonly {
		/** @internal */
		value: string;
		/** @internal */
		label: string;
		/** @internal */
		disabledReason?: string;
	}[];
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
		}
	>;
}

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
	merge: "replace";
	/** @public */
	form: {
		/** @public */
		label: string;
		/** @public */
		description?: string;
		/** @public */
		group: string;
		/** @public */
		control:
			| "text"
			| "textarea"
			| "select"
			| "model"
			| "number"
			| "checkbox"
			| "multiselect"
			| "named-selection-list";
		/** Repository selection metadata for the scope overview. @public */
		overview?: "repository-mapping";
		/** Load multi-select choices only after the operator enters a query. @public */
		search?: {
			/** Minimum trimmed query length. @public */
			minimumLength: number;
			/** @public */
			placeholder?: string;
		};
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
	/** Dynamic options load separately from effective values. @internal */
	choicesDeferred?: boolean;
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

/** Optional collection presentation owned by the declaring integration. @public */
export interface SettingsScopeOverview {
	/** Singular item name, such as Component. @public */
	itemLabel: string;
	/** Plural item name, such as Components. @public */
	itemLabelPlural: string;
	/** Group labels separated from item names by labelSeparator. @public */
	parentLabel?: string;
	/** Delimiter in discovered subject labels, for example " / ". @public */
	labelSeparator?: string;
}

/** @internal */
export interface SettingsScopesResponse {
	/** @internal */
	scopes: Array<{
		/** @internal */
		id: string;
		/** @internal */
		label: string;
		/** @internal */
		overview?: SettingsScopeOverview;
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

/** Compact, locally resolved summaries; remote choice discovery is never needed. @internal */
export interface SettingsOverviewResponse {
	/** @internal */
	items: Array<{
		/** @internal */ subjectId: string;
		/** Active overrides, excluding resets. @internal */ customized: string[];
		/** Present only when a field declares a repository mapping. @internal */ mapping?: SettingChoice[];
		/** Resolution failures stay separate from unmapped/default states. @internal */ errors: string[];
	}>;
}

/** One named set of selections. IDs survive renames and reordering. @public */
export interface NamedSelection {
	/** @public */ id: string;
	/** @public */ name: string;
	/** @public */ values: string[];
}

/** Retained selections for both flat and named selection controls. @internal */
export function settingSelectionValues(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value.flatMap((entry) =>
				typeof entry === "string"
					? [entry]
					: entry && Array.isArray(entry.values)
						? entry.values.filter((v: unknown): v is string => typeof v === "string")
						: [],
			),
		),
	];
}

/** @public */
export type FormFieldKind = "text" | "textarea" | "number" | "boolean" | "select";

/** @public */
export interface FormFieldOptionDefinition {
	/** @internal */
	value: string;
	/** @internal */
	label: string;
	/** @internal */
	description?: string;
	/** Values selected by this option when used as a launcher preset. @public */
	selectionValues?: readonly string[];
}

/** @internal */
export interface FormFieldPublishDefinition {
	/** Product name to publish. Defaults to the field id. @internal */
	product?: string;
}

/** @internal */
export interface FormFieldStateDefinition {
	/** Dot-separated path in process state to write the submitted field value to. @internal */
	path: string;
}

/** @public */
export interface FormFieldDefinition<TKind extends FormFieldKind = FormFieldKind> {
	/** @public */
	id: string;
	/** @public */
	label: string;
	/** @public */
	kind: TKind;
	/** @public */
	required?: boolean;
	/** @public */
	placeholder?: string;
	/** @public */
	description?: string;
	/** @internal */
	options?: readonly FormFieldOptionDefinition[];
	/** Select several values, serialized as newline-separated stable option IDs. @public */
	multiple?: boolean;
	/** Show a local search and selection count for a multiple select. @public */
	searchable?: boolean;
	/** Multiple-select field whose selected options supply selectionValues presets. @public */
	presetsFrom?: string;
	/** Clear this field when any of these launcher fields changes. @public */
	resetOn?: readonly string[];
	/** @internal */
	rememberRecentValues?: boolean;
	/** Publish this field as transition-scoped product/input data. @internal */
	publish?: true | FormFieldPublishDefinition;
	/** Persist this field value into process state. @internal */
	state?: FormFieldStateDefinition;
}

/** @public */
export type ActionFormFieldKind = Exclude<FormFieldKind, "select">;
/** @public */
export type ActionFormFieldDefinition = Omit<
	FormFieldDefinition<ActionFormFieldKind>,
	"options" | "rememberRecentValues"
> & {
	/** Share this textual value across compatible action forms as their primary prompt. @internal */
	primaryPrompt?: true;
};

/** @public */
export interface FormDefinition<TField extends FormFieldDefinition = FormFieldDefinition> {
	/** @public */
	id: string;
	/** @public */
	title: string;
	/** @public */
	fields: readonly TField[];
	/** @public */
	submitLabel?: string;
}

/** @public */
export type ActionFormDefinition = FormDefinition<ActionFormFieldDefinition>;

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
}

/** @internal */
export interface FormFieldPublishDefinition {
	/** Product name to publish. Defaults to the field id. */
	/** @internal */
	product?: string;
}

/** @internal */
export interface FormFieldStateDefinition {
	/** Dot-separated path in process state to write the submitted field value to. */
	/** @internal */
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
	/** @internal */
	rememberRecentValues?: boolean;
	/** Publish this field as transition-scoped product/input data. */
	/** @internal */
	publish?: true | FormFieldPublishDefinition;
	/** Persist this field value into process state. */
	/** @internal */
	state?: FormFieldStateDefinition;
}

/** @public */
export type ActionFormFieldKind = Exclude<FormFieldKind, "select">;
/** @public */
export type ActionFormFieldDefinition = Omit<
	FormFieldDefinition<ActionFormFieldKind>,
	"options" | "rememberRecentValues"
> & {
	/** Share this textual value across compatible action forms as their primary prompt. */
	/** @internal */
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

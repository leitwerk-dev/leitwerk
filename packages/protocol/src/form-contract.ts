export type FormFieldKind = "text" | "textarea" | "number" | "boolean" | "select";

export interface FormFieldOptionDefinition {
	value: string;
	label: string;
	description?: string;
}

export interface FormFieldPublishDefinition {
	/** Product name to publish. Defaults to the field id. */
	product?: string;
}

export interface FormFieldStateDefinition {
	/** Dot-separated path in process state to write the submitted field value to. */
	path: string;
}

export interface FormFieldDefinition<TKind extends FormFieldKind = FormFieldKind> {
	id: string;
	label: string;
	kind: TKind;
	required?: boolean;
	placeholder?: string;
	description?: string;
	options?: readonly FormFieldOptionDefinition[];
	rememberRecentValues?: boolean;
	/** Publish this field as transition-scoped product/input data. */
	publish?: true | FormFieldPublishDefinition;
	/** Persist this field value into process state. */
	state?: FormFieldStateDefinition;
}

export type ActionFormFieldKind = Exclude<FormFieldKind, "select">;
export type ActionFormFieldDefinition = Omit<
	FormFieldDefinition<ActionFormFieldKind>,
	"options" | "rememberRecentValues"
> & {
	/** Share this textual value across compatible action forms as their primary prompt. */
	primaryPrompt?: true;
};

export interface FormDefinition<TField extends FormFieldDefinition = FormFieldDefinition> {
	id: string;
	title: string;
	fields: readonly TField[];
	submitLabel?: string;
}

export type ActionFormDefinition = FormDefinition<ActionFormFieldDefinition>;

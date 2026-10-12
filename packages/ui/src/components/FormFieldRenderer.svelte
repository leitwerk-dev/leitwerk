<script lang="ts">
import type {
	FormFieldDefinition,
	FormFieldOptionDefinition,
} from "@leitwerk-dev/protocol/form-contract";

type FieldValue = string | number | boolean;
type FieldMarker = "launcher" | "action";

interface Props {
	field: FormFieldDefinition;
	id: string;
	value: FieldValue;
	errors?: readonly string[];
	descriptionId?: string;
	errorId?: string;
	describedBy?: string;
	marker?: FieldMarker;
	textareaRows?: number;
	options?: readonly FormFieldOptionDefinition[];
	optionDetails?: Readonly<Record<string, string>>;
	selectedOptionDescription?: string | null;
	selectedOptionDescriptionId?: string;
	recentValues?: readonly string[];
	layout?: "stacked" | "split";
	onValueChange: (field: FormFieldDefinition, value: FieldValue) => void;
	onTextBlur?: () => void;
	onRecentValue?: (field: FormFieldDefinition, value: string) => void;
}

let {
	field,
	id,
	value,
	errors = [],
	descriptionId = undefined,
	errorId = undefined,
	describedBy = undefined,
	marker = "launcher",
	textareaRows = 4,
	options = [],
	optionDetails = undefined,
	selectedOptionDescription = null,
	selectedOptionDescriptionId = undefined,
	recentValues = [],
	layout = "stacked",
	onValueChange,
	onTextBlur = undefined,
	onRecentValue = undefined,
}: Props = $props();

const markerAttrs = $derived(
	marker === "action" ? { "data-action-form-field": true } : { "data-launcher-form-field": true },
);
const invalid = $derived(errors.length > 0);
const controlAttrs = $derived({
	id,
	...markerAttrs,
	required: field.required ? true : undefined,
	"aria-describedby": describedBy,
	"aria-invalid": invalid,
	"aria-required": field.required ? true : undefined,
});
const stringValue = $derived(String(value ?? ""));
const booleanValue = $derived(value === true);
let search = $state("");
const selectedValues = $derived(stringValue.split("\n").filter(Boolean));
const visibleOptions = $derived(
	field.searchable && search.trim()
		? options.filter((option) =>
				`${option.label} ${option.value}`.toLowerCase().includes(search.trim().toLowerCase()),
			)
		: options,
);
</script>

<div class="form-field-group" class:invalid onfocusout={(event) => {
	if (!event.currentTarget.contains(event.relatedTarget as Node | null) && field.kind !== "text" && field.kind !== "number" && field.kind !== "textarea") onTextBlur?.();
}} class:multi-select={field.kind === "select" && field.multiple} class:is-split={layout === "split" && field.kind !== "boolean"}>
	{#if field.kind === "boolean"}
		<div class="checkbox-row">
			<input
				{...controlAttrs}
				type="checkbox"
				checked={booleanValue}
				onchange={(event) => onValueChange(field, (event.currentTarget as HTMLInputElement).checked)}
			/>
			<label for={id} class="checkbox-label">
				{field.label}
				{#if field.required}
					<span class="required-marker" title="This field is required" aria-hidden="true">*</span>
				{/if}
			</label>
		</div>
	{:else if field.kind === "select" && field.multiple}
		<div class="multi-select-label">
			<div class="field-label" id={`${id}-label`}>
				{field.label}
				{#if field.required}
					<span class="required-marker" title="This field is required" aria-hidden="true">*</span>
				{:else}
					<span class="optional-marker">Optional</span>
				{/if}
			</div>
			{#if field.description}
				<p class="field-description" id={descriptionId}>{field.description}</p>
			{/if}
		</div>
	{:else}
		<label class="field-label" for={id}>
			{field.label}
			{#if field.required}
				<span class="required-marker" title="This field is required" aria-hidden="true">*</span>
			{/if}
		</label>
	{/if}

	{#if field.description && !(field.kind === "select" && field.multiple)}
		<p class="field-description" id={descriptionId}>{field.description}</p>
	{/if}

	{#if field.kind === "textarea"}
		<textarea
			{...controlAttrs}
			rows={textareaRows}
			value={stringValue}
			placeholder={field.placeholder ?? undefined}
			oninput={(event) => onValueChange(field, (event.currentTarget as HTMLTextAreaElement).value)}
			onblur={onTextBlur}
		></textarea>
	{:else if field.kind === "select" && field.multiple}
		<div class="multi-select-control" id={id} role="group" tabindex="-1" data-invalid={invalid} aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
			{#if field.searchable}
				<p class="selection-count" aria-live="polite">{selectedValues.length} selected</p>
				<div class="selection-search">
					<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
					<input type="search" aria-label={`Search ${field.label.toLowerCase()}`} placeholder={field.placeholder ?? "Search options…"} bind:value={search} />
				</div>
			{/if}
			<div class="selection-options" class:searchable={field.searchable}>
				{#each visibleOptions as option (option.value)}
					<label class="checkbox-row selection-option">
						<input type="checkbox" {...markerAttrs} aria-invalid={invalid} aria-describedby={describedBy} checked={selectedValues.includes(option.value)} onchange={(event) => {
							onValueChange(field, (event.currentTarget.checked ? [...new Set([...selectedValues, option.value])] : selectedValues.filter((value) => value !== option.value)).join("\n"));
						}} />
						<span class="selection-name">{option.label}</span>
						{#if optionDetails?.[option.value]}<span class="selection-detail">{optionDetails[option.value]}</span>{/if}
					</label>
				{:else}
					<p class="selection-empty">{search.trim() ? "No matching options. Try another search." : "No options available."}</p>
				{/each}
			</div>
			{#if field.presetsFrom}<p class="selection-hint">Your manual changes are kept when you change groups.</p>{/if}
		</div>
	{:else if field.kind === "select"}
		<select
			{...controlAttrs}
			value={stringValue}
			onchange={(event) => onValueChange(field, (event.currentTarget as HTMLSelectElement).value)}
		>
			<option value="">Choose an option</option>
			{#each options as option, index (`${option.value}:${option.label}:${index}`)}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
		{#if selectedOptionDescription}
			<p class="field-option-description" id={selectedOptionDescriptionId}>
				{selectedOptionDescription}
			</p>
		{/if}
	{:else if field.kind === "boolean"}
		<!-- boolean input rendered above -->
	{:else}
		<input
			{...controlAttrs}
			type={field.kind === "number" ? "number" : "text"}
			value={stringValue}
			placeholder={field.placeholder ?? undefined}
			oninput={(event) => onValueChange(field, (event.currentTarget as HTMLInputElement).value)}
			onblur={onTextBlur}
		/>
		{#if field.kind === "text" && recentValues.length > 0}
			<div class="field-recents" data-field-recents={field.id}>
				<p class="field-recents-label">Recent</p>
				<div class="field-recent-chip-list">
					{#each recentValues as recentValue (recentValue)}
						<button
							type="button"
							class="field-recent-chip"
							data-recent-value={recentValue}
							onclick={() => (onRecentValue ?? onValueChange)(field, recentValue)}
						>
							{recentValue}
						</button>
					{/each}
				</div>
			</div>
		{/if}
	{/if}

	{#if errors.length > 0}
		<ul class="field-error-list" id={errorId} aria-live="polite">
			{#each errors as message (message)}
				<li>{message}</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.form-field-group.invalid .multi-select-control,
	.form-field-group.invalid > .checkbox-row {
		outline: 1px solid var(--chronicle-danger);
		outline-offset: 3px;
	}

	.form-field-group {
		display: grid;
		gap: var(--space-xs);
	}

	.form-field-group.is-split {
		grid-template-columns: minmax(188px, 0.36fr) minmax(0, 1fr);
		gap: var(--space-xs) var(--space-lg);
		align-items: start;
	}

	.form-field-group.is-split .field-label {
		grid-column: 1;
		padding-top: var(--space-xs);
	}

	.form-field-group.is-split .field-description {
		grid-column: 1;
		max-width: 24ch;
	}

	.form-field-group.is-split input,
	.form-field-group.is-split textarea,
	.form-field-group.is-split select {
		grid-column: 2;
		grid-row: 1 / span 2;
	}

	.form-field-group.is-split .field-option-description,
	.form-field-group.is-split .field-recents,
	.form-field-group.is-split .field-error-list {
		grid-column: 2;
	}

	.multi-select {
		padding: var(--space-lg) 0;
		border-top: 1px solid var(--chronicle-border);
	}

	.form-field-group.is-split .multi-select-control {
		grid-column: 2;
		grid-row: 1;
	}
	.multi-select-label {
		display: grid;
		gap: var(--space-xs);
	}


	.multi-select-control {
		min-width: 0;
	}

	.selection-count {
		margin: 0 0 12px;
		text-align: right;
		color: var(--chronicle-link);
		font-size: 0.875rem;
		font-weight: 620;
	}

	.selection-search {
		position: relative;
		margin-bottom: 12px;
	}

	.selection-search svg {
		position: absolute;
		left: 14px;
		top: 14px;
		width: 18px;
		height: 18px;
		color: var(--chronicle-text-muted);
	}

	.form-field-group .selection-search input {
		padding-left: 42px;
	}

	.selection-options {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 24px;
	}

	.selection-option {
		min-height: 44px;
		align-items: center;
		cursor: pointer;
	}

	.selection-name {
		overflow-wrap: anywhere;
	}

	.selection-options.searchable {
		display: block;
		max-height: 400px;
		overflow-y: auto;
		border: 1px solid var(--chronicle-border);
		border-radius: 14px;
	}

	.searchable .selection-option {
		padding: 12px 14px;
		font-size: 0.875rem;
	}

	.searchable .selection-option + .selection-option {
		border-top: 1px solid var(--chronicle-border);
	}

	.searchable .selection-option:hover {
		background: var(--chronicle-panel-muted);
	}

	.selection-detail {
		margin-left: auto;
		max-width: 40%;
		flex-shrink: 0;
		text-align: right;
		font-size: 0.75rem;
		color: var(--chronicle-text-muted);
	}

	.selection-hint, .selection-empty {
		margin: 12px 0 0;
		color: var(--chronicle-text-muted);
		font-size: 0.8125rem;
		line-height: 1.55;
	}

	.selection-empty {
		margin: 0;
		padding: 14px;
	}

	.optional-marker {
		margin-left: 6px;
		color: var(--chronicle-text-muted);
		font-size: 0.75rem;
		font-weight: 400;
	}


	.field-label,
	.checkbox-label {
		margin: 0;
		font-size: 0.95rem;
		line-height: 1.4;
		font-weight: 620;
		color: var(--chronicle-text);
	}

	.checkbox-row {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.form-field-group input,
	.form-field-group textarea,
	.form-field-group select {
		width: 100%;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 88%, white 12%);
		border-radius: 14px;
		padding: 12px 14px;
		font: inherit;
		background: color-mix(in srgb, white 88%, var(--chronicle-panel-muted) 12%);
		color: var(--chronicle-text);
		transition:
			border-color var(--duration-fast) var(--ease-out-quart),
			background var(--duration-fast) var(--ease-out-quart),
			box-shadow var(--duration-fast) var(--ease-out-quart);
	}

	.form-field-group input::placeholder,
	.form-field-group textarea::placeholder {
		color: var(--chronicle-text-faint);
	}

	.form-field-group input[aria-invalid="true"],
	.form-field-group textarea[aria-invalid="true"],
	.form-field-group select[aria-invalid="true"] {
		border-color: color-mix(in srgb, var(--chronicle-danger) 64%, var(--chronicle-border) 36%);
		background: color-mix(in srgb, white 92%, var(--chronicle-danger) 8%);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--chronicle-danger) 12%, transparent 88%);
	}

	.form-field-group input:hover,
	.form-field-group textarea:hover,
	.form-field-group select:hover {
		border-color: color-mix(in srgb, var(--chronicle-accent) 20%, var(--chronicle-border) 80%);
	}

	.form-field-group input:focus-visible,
	.form-field-group textarea:focus-visible,
	.form-field-group select:focus-visible,
	.field-recent-chip:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--chronicle-accent) 72%, white 28%);
		outline-offset: 2px;
	}

	.checkbox-row input {
		width: 20px;
		height: 20px;
		min-height: auto;
		padding: 0;
		margin-top: 2px;
		flex-shrink: 0;
		accent-color: var(--chronicle-accent);
	}

	.form-field-group textarea {
		resize: vertical;
		min-height: 104px;
	}

	.field-description,
	.field-option-description,
	.field-error-list,
	.field-recents-label {
		margin: 0;
		font-size: 0.875rem;
		line-height: 1.55;
		color: var(--chronicle-text-muted);
	}

	.field-option-description {
		color: var(--chronicle-link);
	}

	.required-marker {
		color: color-mix(in srgb, var(--chronicle-attention) 78%, var(--chronicle-text) 22%);
		margin-left: 4px;
		cursor: help;
	}

	.field-error-list {
		padding-left: 18px;
		color: var(--chronicle-danger-text);
	}

	.field-error-list li {
		margin: 2px 0;
	}

	.field-recents {
		display: grid;
		gap: 6px;
	}

	.field-recent-chip-list {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.field-recent-chip {
		border: 1px solid color-mix(in srgb, var(--chronicle-border-strong) 82%, white 18%);
		border-radius: 999px;
		padding: 6px 12px;
		background: color-mix(in srgb, var(--chronicle-card-surface) 95%, white 5%);
		color: var(--chronicle-text);
		font: inherit;
		font-size: 0.76rem;
		cursor: pointer;
		transition:
			transform var(--duration-fast) var(--ease-out-quart),
			border-color var(--duration-fast) var(--ease-out-quart),
			background var(--duration-fast) var(--ease-out-quart);
	}

	.field-recent-chip:hover {
		transform: translateY(-1px);
		border-color: color-mix(in srgb, var(--chronicle-accent) 28%, var(--chronicle-border-strong) 72%);
		background: color-mix(in srgb, white 94%, var(--chronicle-accent-soft) 6%);
	}

	@container (max-width: 760px) {
		.form-field-group.is-split {
			grid-template-columns: 1fr;
			gap: var(--space-xs);
		}

		.form-field-group.is-split .field-label,
		.form-field-group.is-split .field-description,
		.form-field-group.is-split input,
		.form-field-group.is-split textarea,
		.form-field-group.is-split select,
		.form-field-group.is-split .field-option-description,
		.form-field-group.is-split .multi-select-control,
		.form-field-group.is-split .field-recents,
		.form-field-group.is-split .field-error-list {
			grid-column: 1;
			grid-row: auto;
		}

		.form-field-group.is-split .field-label {
			padding-top: 0;
		}
	}
</style>

<script lang="ts">
import type { FormFieldDefinition, FormFieldOptionDefinition } from "../lib/api";

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
const stringValue = $derived(String(value ?? ""));
const booleanValue = $derived(value === true);
</script>

<div class="form-field-group" class:is-split={layout === "split" && field.kind !== "boolean"}>
	{#if field.kind === "boolean"}
		<div class="checkbox-row">
			<input
				id={id}
				{...markerAttrs}
				type="checkbox"
				required={field.required ? true : undefined}
				checked={booleanValue}
				aria-describedby={describedBy}
				aria-invalid={invalid}
				aria-required={field.required ? true : undefined}
				onchange={(event) => onValueChange(field, (event.currentTarget as HTMLInputElement).checked)}
			/>
			<label for={id} class="checkbox-label">
				{field.label}
				{#if field.required}
					<span class="required-marker" title="This field is required" aria-hidden="true">*</span>
				{/if}
			</label>
		</div>
	{:else}
		<label class="field-label" for={id}>
			{field.label}
			{#if field.required}
				<span class="required-marker" title="This field is required" aria-hidden="true">*</span>
			{/if}
		</label>
	{/if}

	{#if field.description}
		<p class="field-description" id={descriptionId}>{field.description}</p>
	{/if}

	{#if field.kind === "textarea"}
		<textarea
			id={id}
			{...markerAttrs}
			rows={textareaRows}
			required={field.required ? true : undefined}
			value={stringValue}
			placeholder={field.placeholder ?? undefined}
			aria-describedby={describedBy}
			aria-invalid={invalid}
			aria-required={field.required ? true : undefined}
			oninput={(event) => onValueChange(field, (event.currentTarget as HTMLTextAreaElement).value)}
			onblur={onTextBlur}
		></textarea>
	{:else if field.kind === "select"}
		<select
			id={id}
			{...markerAttrs}
			value={stringValue}
			required={field.required ? true : undefined}
			aria-describedby={describedBy}
			aria-invalid={invalid}
			aria-required={field.required ? true : undefined}
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
			id={id}
			{...markerAttrs}
			type={field.kind === "number" ? "number" : "text"}
			required={field.required ? true : undefined}
			value={stringValue}
			placeholder={field.placeholder ?? undefined}
			aria-describedby={describedBy}
			aria-invalid={invalid}
			aria-required={field.required ? true : undefined}
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
		<ul class="field-error-list" id={errorId} role="alert">
			{#each errors as message (message)}
				<li>{message}</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
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

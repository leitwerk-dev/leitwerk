<script lang="ts">
import type { ProcessActionFieldDefinition, ProcessActionSummary } from "../../lib/api.js";
import { type ActionSectionController, findQuickActionField } from "../lib/action-bindings.js";

interface Props {
	actionSectionController: ActionSectionController;
	onOpenDetails: (actionId: string) => void;
	decisionTitle?: string | null;
	onViewContext?: () => void;
}

let {
	actionSectionController: actionBindings,
	onOpenDetails,
	decisionTitle,
	onViewContext,
}: Props = $props();

let fieldError = $state<{
	actionId: string;
	fieldId: string;
	message: string;
} | null>(null);

const actions = $derived(actionBindings.actionSectionActions);
const selectedAction = $derived(
	actions.find((action) => action.id === actionBindings.selectedActionId) ?? null,
);
const quickField = $derived.by(() => findQuickActionField(selectedAction));
const currentFieldError = $derived(
	fieldError && fieldError.actionId === selectedAction?.id && fieldError.fieldId === quickField?.id
		? fieldError.message
		: null,
);
const needsDetailedForm = $derived(
	Boolean(selectedAction?.form?.fields.length) && quickField === null,
);
const hasAdvancedOptions = $derived(
	Boolean(
		selectedAction &&
			(selectedAction.supportsScheduling ||
				selectedAction.supportsNextTurnModelOverride ||
				needsDetailedForm),
	),
);

function fieldValue(action: ProcessActionSummary, field: ProcessActionFieldDefinition): string {
	return String(actionBindings.getActionFieldValue(action.id, field));
}

function updateField(
	action: ProcessActionSummary,
	field: ProcessActionFieldDefinition,
	event: Event,
) {
	fieldError = null;
	actionBindings.setActionFieldValue(
		action.id,
		field,
		(event.currentTarget as HTMLTextAreaElement).value,
	);
}

function selectAction(event: Event) {
	actionBindings.selectAction((event.currentTarget as HTMLSelectElement).value);
	fieldError = null;
}

function validateQuickField(action: ProcessActionSummary): boolean {
	if (!quickField?.required) {
		return true;
	}
	if (fieldValue(action, quickField).trim() !== "") {
		return true;
	}
	fieldError = {
		actionId: action.id,
		fieldId: quickField.id,
		message: `${quickField.label} is required.`,
	};
	return false;
}

async function submitSelectedAction(event: SubmitEvent) {
	event.preventDefault();
	if (!selectedAction || needsDetailedForm || !validateQuickField(selectedAction)) {
		return;
	}
	await actionBindings.submitActionDecision(selectedAction);
}

function handleComposerKeydown(event: KeyboardEvent) {
	if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) {
		return;
	}
	event.preventDefault();
	(event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
}

function openDetails() {
	if (!selectedAction) {
		return;
	}
	onOpenDetails(selectedAction.id);
}

function submitLabel(action: ProcessActionSummary): string {
	if (actionBindings.actionBusyId === action.id) {
		return quickField ? "Sending…" : "Working…";
	}
	return quickField ? "Send" : (action.form?.submitLabel ?? action.label);
}

function submitAccessibleLabel(action: ProcessActionSummary): string {
	return action.form?.submitLabel ?? action.label;
}
</script>

{#if selectedAction}
	<section
		class="compact-action-composer"
		data-section="compact-action-composer"
		aria-label="Choose the next action"
	>
		<div class="composer-heading">
			<p><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2" y="2" width="16" height="16" rx="4" /><path d="M10 5v6m0 3h.01" /></svg><strong>Waiting for your decision</strong>{#if decisionTitle}<span class="decision-title">· {decisionTitle}</span>{/if}</p>
			{#if onViewContext}<button type="button" class="view-context" onclick={onViewContext}>View context</button>{/if}
		</div>
		<form
			class="composer-form"
			class:without-options={!hasAdvancedOptions}
			aria-busy={actionBindings.actionBusyId !== null}
			onsubmit={submitSelectedAction}
		>
			<div class="action-picker">
				<label for="compact-action-choice">Next action</label>
				<select
					id="compact-action-choice"
					value={selectedAction.id}
					disabled={actionBindings.actionBusyId !== null}
					onchange={selectAction}
				>
					{#each actions as action (action.id)}
						<option value={action.id}>{action.label}</option>
					{/each}
				</select>
			</div>

			{#if quickField}
				<div class="feedback-field" class:has-error={currentFieldError !== null}>
					<label for={`compact-action-${selectedAction.id}-${quickField.id}`}>
						{quickField.label}
					</label>
					<textarea
						id={`compact-action-${selectedAction.id}-${quickField.id}`}
						rows="1"
						placeholder={quickField.placeholder ?? "Add feedback for the next turn"}
						value={fieldValue(selectedAction, quickField)}
						disabled={actionBindings.actionBusyId !== null}
						aria-invalid={currentFieldError ? "true" : undefined}
						aria-describedby={currentFieldError ? "compact-action-error" : undefined}
						oninput={(event) => updateField(selectedAction, quickField, event)}
						onblur={() => actionBindings.commitActionPreview(selectedAction.id)}
						onkeydown={handleComposerKeydown}
					></textarea>
					{#if currentFieldError}
						<p id="compact-action-error" class="field-error" role="alert">{currentFieldError}</p>
					{/if}
				</div>
			{:else}
				<div class="action-context">
					<span>{selectedAction.description ?? `Continue with ${selectedAction.label.toLowerCase()}.`}</span>
				</div>
			{/if}

			{#if hasAdvancedOptions}
				<button
					type="button"
					class="options-button"
					data-pressable="true"
					disabled={actionBindings.actionBusyId !== null}
					onclick={openDetails}
				>
					{needsDetailedForm ? "Open details" : "Options"}
				</button>
			{/if}

			{#if !needsDetailedForm}
				<button
					type="submit"
					class="submit-button"
					data-pressable="true"
					disabled={actionBindings.actionBusyId !== null}
					aria-label={submitAccessibleLabel(selectedAction)}
				>
					{submitLabel(selectedAction)}
				</button>
			{/if}
		</form>

		{#if actionBindings.actionError}
			<p class="action-error" role="alert">{actionBindings.actionError}</p>
		{/if}
	</section>
{/if}

<style>
	.compact-action-composer {
		container-type: inline-size;
		flex: 0 0 auto;
		padding: var(--space-sm) var(--space-sm) max(var(--space-sm), env(safe-area-inset-bottom));
		border: 1px solid var(--chronicle-border);
		border-radius: 10px;
		background: var(--chronicle-card-surface-strong);
		animation: composer-enter var(--duration-fast) var(--ease-out-quart);
	}

	.composer-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
	.composer-heading p { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 0; font-size: var(--type-body-sm); line-height: 1.4; color: var(--chronicle-text); }
	.composer-heading svg { color: var(--chronicle-attention); flex-shrink: 0; }
	.composer-heading strong { font-weight: 650; }
	.decision-title { color: var(--chronicle-text-muted); }
	.view-context { flex-shrink: 0; min-height: 28px; padding: 3px 0; border: 0; border-radius: 4px; background: transparent; color: var(--chronicle-accent); font: inherit; font-size: var(--type-body-sm); cursor: pointer; }
	.view-context:hover { text-decoration: underline; text-underline-offset: 3px; }

	.composer-form {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		gap: var(--space-xs);
		align-items: end;
	}

	.action-picker {
		grid-column: 1 / 3;
	}

	.action-picker,
	.feedback-field {
		display: grid;
		gap: var(--space-2xs);
	}

	.action-picker label,
	.feedback-field label {
		color: var(--chronicle-text-muted);
		font-size: var(--type-body-sm);
		font-weight: 400;
		line-height: 1.2;
	}

	.action-picker select,
	.feedback-field,
	.action-context {
		min-height: 48px;
		border: 1px solid var(--chronicle-border);
		border-radius: 10px;
		background: var(--chronicle-panel-surface);
		color: var(--chronicle-text);
	}

	.action-picker label {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.action-picker select {
		width: 100%;
		padding: 0 var(--space-sm);
		font-size: var(--type-body);
		font-weight: 620;
		cursor: pointer;
	}

	.feedback-field {
		grid-column: 1 / 3;
		padding: var(--space-2xs) var(--space-sm);
	}

	.feedback-field:focus-within {
		border-color: var(--chronicle-accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--chronicle-accent) 14%, transparent 86%);
	}

	.feedback-field.has-error {
		border-color: var(--chronicle-danger);
		background: var(--chronicle-danger-surface-soft);
	}

	.feedback-field textarea {
		field-sizing: content;
		width: 100%;
		min-height: 20px;
		max-height: 88px;
		padding: 0;
		resize: none;
		border: 0;
		outline: 0;
		box-shadow: none;
		background: transparent;
		color: var(--chronicle-text);
		font-size: var(--type-body);
		line-height: 1.45;
	}

	.feedback-field textarea::placeholder {
		color: var(--chronicle-text-faint);
		opacity: 1;
	}

	.feedback-field.has-error textarea::placeholder {
		color: var(--chronicle-text-muted);
	}

	.field-error,
	.action-error {
		margin: 0;
		color: var(--chronicle-danger-text);
		font-size: var(--type-body);
		line-height: 1.5;
	}

	.action-error {
		margin-top: var(--space-xs);
		max-width: 75ch;
	}

	.action-context {
		grid-column: 1 / 3;
		display: flex;
		align-items: center;
		padding: var(--space-xs) var(--space-sm);
		color: var(--chronicle-text-muted);
		font-size: var(--type-body);
		line-height: 1.5;
	}

	.options-button,
	.submit-button {
		min-height: 48px;
		padding: 0 var(--space-md);
		border-radius: 10px;
		font-size: var(--type-body);
		font-weight: 620;
		cursor: pointer;
		white-space: nowrap;
	}

	.options-button {
		grid-column: 3;
		grid-row: 1;
		border: 1px solid var(--chronicle-border);
		background: var(--chronicle-panel-surface);
		color: var(--chronicle-text-muted);
	}

	.submit-button {
		grid-column: 3;
		grid-row: 2;
		border: 1px solid var(--chronicle-text);
		background: var(--chronicle-text);
		color: var(--chronicle-text-on-accent);
	}

	.options-button:hover:not(:disabled) {
		border-color: var(--chronicle-accent);
		color: var(--chronicle-text);
	}

	.submit-button:hover:not(:disabled) {
		transform: translateY(-1px);
		background: color-mix(in srgb, var(--chronicle-text) 88%, var(--chronicle-accent) 12%);
	}

	.options-button:active:not(:disabled),
	.submit-button:active:not(:disabled) {
		transform: translateY(0);
	}

	.options-button:disabled,
	.submit-button:disabled,
	.action-picker select:disabled,
	.feedback-field textarea:disabled {
		cursor: not-allowed;
		opacity: 0.58;
	}

	.composer-form.without-options .action-picker {
		grid-column: 1 / -1;
	}

	@container (min-width: 620px) {
		.composer-form {
			grid-template-columns: minmax(100px, 120px) minmax(180px, 1fr) auto auto;
		}

		.feedback-field,
		.action-context,
		.submit-button {
			grid-column: auto;
			grid-row: auto;
		}

		.action-picker,
		.options-button {
			grid-column: auto;
			grid-row: auto;
		}

		.composer-form.without-options .action-picker {
			grid-column: auto;
		}
	}

	@keyframes composer-enter {
		from {
			opacity: 0;
			transform: translateY(var(--space-xs));
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.compact-action-composer {
			animation: none;
		}
	}
</style>

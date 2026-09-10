<script lang="ts">
import type { ProcessExternalTriggerSignal } from "@leitwerk-dev/protocol";
import { tick } from "svelte";
import FormFieldRenderer from "../../components/FormFieldRenderer.svelte";
import ScheduleDateTimePicker from "../../components/ScheduleDateTimePicker.svelte";
import type {
	ProcessActionFieldDefinition,
	ProcessActionSummary,
	ProcessExternalTriggerSummary,
	ProcessModelConfigurationView,
	ProcessSelectedTurnSummary,
} from "../../lib/api";
import { formatRelativeTime } from "../../lib/format.js";
import type { ActionSectionController } from "../lib/action-bindings.js";
import { buildActionModelDisplay } from "../lib/action-model-display.js";
import { describeActionPreview as describeSharedActionPreview } from "../lib/action-preview.js";
import ModelProfileOptions from "./ModelProfileOptions.svelte";

interface Props {
	anchorId: string;
	isFocused: boolean;
	actionSectionController: ActionSectionController;
	externalTriggers: readonly ProcessExternalTriggerSummary[];
	externalTriggerSignals: readonly ProcessExternalTriggerSignal[];
	selectedTurn?: ProcessSelectedTurnSummary | null;
	modelConfiguration: ProcessModelConfigurationView;
}

let {
	anchorId,
	isFocused,
	actionSectionController: actionBindings,
	externalTriggers = [],
	externalTriggerSignals = [],
	selectedTurn = null,
	modelConfiguration,
}: Props = $props();

let sectionElement: HTMLElement | null = null;
let fieldErrors = $state<Record<string, string[]>>({});
let promptCacheClock = $state(Date.now());

const actions = $derived(actionBindings.actionSectionActions);
const openAction = $derived(
	actions.find((action) => action.id === actionBindings.openActionFormId) ?? null,
);
const showOpenActionPanel = $derived(Boolean(openAction));
const sectionTitle = $derived.by(() => {
	if (openAction) {
		return openAction.label;
	}
	if (actions.length > 0) {
		return "Decide what happens next";
	}
	return "Waiting for an update";
});
const sectionDescription = $derived.by(() => {
	if (openAction?.description) {
		return openAction.description;
	}
	if (selectedTurn?.commentary) {
		return selectedTurn.commentary;
	}
	if (actions.length === 0 && selectedTurn?.description) return selectedTurn.description;
	if (actions.length > 0) {
		return "Review the latest result, then choose what happens next.";
	}
	return "This process continues when one of the events below occurs.";
});

$effect(() => {
	const expiresAt = actionBindings.openActionModelPreview?.warmPromptCache?.expiresAt;
	if (!expiresAt) return;
	const expiresAtMs = Date.parse(expiresAt);
	if (!Number.isFinite(expiresAtMs)) return;
	const timeout = setTimeout(
		() => {
			promptCacheClock = Date.now();
		},
		Math.min(2_147_483_647, Math.max(0, expiresAtMs - Date.now() + 1)),
	);
	return () => clearTimeout(timeout);
});

$effect(() => {
	const currentActionId = openAction?.id ?? null;
	fieldErrors = {};
	if (!currentActionId || !sectionElement) {
		return;
	}
	void tick().then(() => {
		sectionElement?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
		const firstField = sectionElement?.querySelector<HTMLElement>("[data-action-form-field]");
		firstField?.focus?.();
	});
});

function actionFieldDescriptionId(actionId: string, fieldId: string): string {
	return `${actionBindings.actionFieldDomId(actionId, fieldId)}-description`;
}

function actionFieldErrorId(actionId: string, fieldId: string): string {
	return `${actionBindings.actionFieldDomId(actionId, fieldId)}-errors`;
}

function fieldErrorKey(actionId: string, fieldId: string): string {
	return `${actionId}:${fieldId}`;
}

function getFieldErrors(actionId: string, fieldId: string): string[] {
	return fieldErrors[fieldErrorKey(actionId, fieldId)] ?? [];
}

function clearFieldError(actionId: string, fieldId: string) {
	const errorKey = fieldErrorKey(actionId, fieldId);
	if (!fieldErrors[errorKey]) {
		return;
	}
	const nextErrors = { ...fieldErrors };
	delete nextErrors[errorKey];
	fieldErrors = nextErrors;
}

function setValidatedFieldValue(
	actionId: string,
	field: ProcessActionFieldDefinition,
	value: string | number | boolean,
) {
	clearFieldError(actionId, field.id);
	actionBindings.setActionFieldValue(actionId, field, value);
}

function getFieldDescribedBy(
	actionId: string,
	field: ProcessActionFieldDefinition,
): string | undefined {
	const ids: string[] = [];
	if (field.description) {
		ids.push(actionFieldDescriptionId(actionId, field.id));
	}
	if (getFieldErrors(actionId, field.id).length > 0) {
		ids.push(actionFieldErrorId(actionId, field.id));
	}
	return ids.length > 0 ? ids.join(" ") : undefined;
}

function isMissingRequiredValue(actionId: string, field: ProcessActionFieldDefinition): boolean {
	if (!field.required) {
		return false;
	}
	const value = actionBindings.getActionFieldValue(actionId, field);
	if (field.kind === "boolean") {
		return value !== true;
	}
	return String(value).trim() === "";
}

function validateOpenActionForm(action: ProcessActionSummary): boolean {
	if (!action.form) {
		fieldErrors = {};
		return true;
	}

	const nextFieldErrors: Record<string, string[]> = {};
	for (const field of action.form.fields) {
		if (!isMissingRequiredValue(action.id, field)) {
			continue;
		}
		nextFieldErrors[fieldErrorKey(action.id, field.id)] = [
			field.kind === "boolean"
				? `Select "${field.label}" to continue.`
				: `${field.label} is required.`,
		];
	}
	fieldErrors = nextFieldErrors;
	return Object.keys(nextFieldErrors).length === 0;
}

async function focusFirstInvalidField() {
	await tick();
	const invalidField = sectionElement?.querySelector<HTMLElement>(
		`[data-action-form-field][aria-invalid="true"]`,
	);
	invalidField?.focus?.();
	if (invalidField instanceof HTMLElement) {
		invalidField.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}
}

function shouldRunActionImmediately(action: ProcessActionSummary): boolean {
	return (
		action.form !== undefined &&
		action.form.fields.length === 0 &&
		!action.supportsScheduling &&
		!action.supportsNextTurnModelOverride
	);
}

async function handleActionFormSubmit(event: SubmitEvent) {
	event.preventDefault();
	if (!openAction) {
		return;
	}
	if (!validateOpenActionForm(openAction)) {
		await focusFirstInvalidField();
		return;
	}
	await actionBindings.submitActionDecision(openAction);
}

async function handleActionClick(action: ProcessActionSummary) {
	fieldErrors = {};
	if (shouldRunActionImmediately(action)) {
		await actionBindings.submitActionDecision(action);
		return;
	}
	actionBindings.expandActionForm(action.id);
}

function modelOverrideFieldId(actionId: string): string {
	return actionBindings.actionFieldDomId(actionId, "__next-turn-model-profile");
}

function getActionModelDisplay(action: ProcessActionSummary) {
	return buildActionModelDisplay({
		modelPreview: actionBindings.openActionModelPreview,
		availableProfiles: modelConfiguration.availableProfiles,
		selectedModelOverrideValue: actionBindings.getActionModelOverrideValue(action.id),
		now: promptCacheClock,
	});
}

function shouldShowActionModelOverride(action: ProcessActionSummary): boolean {
	return (
		action.supportsNextTurnModelOverride &&
		actionBindings.openActionModelPreview?.kind !== "not_applicable"
	);
}

function isPrimaryActionChoice(actionIndex: number): boolean {
	return actions.length > 1 && actionIndex === 0;
}

function scheduleRunAtFieldId(actionId: string): string {
	return actionBindings.actionFieldDomId(actionId, "__schedule-run-at");
}

function scheduleRunAtHourFieldId(actionId: string): string {
	return `${scheduleRunAtFieldId(actionId)}-hour`;
}

function scheduleRunAtMinuteFieldId(actionId: string): string {
	return `${scheduleRunAtFieldId(actionId)}-minute`;
}

function describeActionPreview(action: ProcessActionSummary): string | null {
	return describeSharedActionPreview(action, { includeTurnKindPrefix: true });
}

function describeActionForm(action: ProcessActionSummary): string {
	if (action.description) {
		return action.description;
	}
	if (action.form) {
		return action.supportsScheduling
			? "Fill in any details this action needs, then choose whether it should run now or later."
			: "Fill in any details this action needs, then run it now.";
	}
	if (action.supportsScheduling) {
		return "Review the action settings, then choose whether it should run now or later.";
	}
	return "Review the action settings, then run it now.";
}

function externalTriggerSignalFor(
	trigger: ProcessExternalTriggerSummary,
): ProcessExternalTriggerSignal | null {
	return externalTriggerSignals.find((signal) => signal.triggerId === trigger.id) ?? null;
}

function presentExternalTriggerSignal(signal: ProcessExternalTriggerSignal) {
	const relativeTime = signal.occurredAt ? formatRelativeTime(signal.occurredAt) : null;
	switch (signal.state) {
		case "error":
			return {
				tone: "attention",
				label: "Error",
				detail: relativeTime ? `Last check failed ${relativeTime}.` : "Last check failed.",
			};
		case "armed":
			return {
				tone: "ready",
				label: "Listening",
				detail: relativeTime ? `Listening since ${relativeTime}.` : "Listening for this event.",
			};
		case "triggered":
			return {
				tone: "neutral",
				label: "Received",
				detail: relativeTime ? `Last event received ${relativeTime}.` : "Event received.",
			};
		case "waiting":
			return {
				tone: "neutral",
				label: "Waiting",
				detail: "Not currently listening for this event.",
			};
	}
}
</script>

<section
	id={anchorId}
	class="action-section"
	class:is-focused={isFocused}
	class:has-open-form={showOpenActionPanel}
	bind:this={sectionElement}
	data-anchor-id={anchorId}
	data-focused={isFocused ? "true" : "false"}
	data-section="leaf-outcome-actions"
	data-action-state={actions.length > 0 ? "required" : "external-trigger"}
	data-action-shortcut-target="true"
	aria-label={actions.length > 0 ? "Action required" : "External trigger status"}
	tabindex="-1"
>
	<div class="action-header">
		<div class="action-header-copy">
			<div class="action-status-row" aria-label={actions.length > 0 ? "Action required" : "External trigger"}>
				<span class="action-status-dot" aria-hidden="true"></span>
				<span>{actions.length > 0 ? "Action required" : "Waiting for an event"}</span>
			</div>
			<h3>{sectionTitle}</h3>
			<p class="action-description">{sectionDescription}</p>
		</div>
		{#if showOpenActionPanel && openAction}
			<div class="action-header-controls">
				<button
					type="button"
					class="secondary-button"
					data-pressable="true"
					disabled={actionBindings.actionBusyId !== null}
					onclick={() => actionBindings.collapseActionForm()}
				>
					Hide form
				</button>
			</div>
		{/if}
	</div>

	{#if actions.length > 0}
		<div class="action-row" role="group" aria-label="Available actions">
			{#each actions as action, actionIndex (action.id)}
				<button
					type="button"
					class:is-primary-choice={isPrimaryActionChoice(actionIndex)}
					class:active={actionBindings.selectedActionId === action.id}
					class:busy={actionBindings.actionBusyId === action.id}
					disabled={actionBindings.actionBusyId !== null}
					data-action-id={action.id}
					data-action-priority={isPrimaryActionChoice(actionIndex) ? "primary" : "secondary"}
					data-supports-scheduling={action.supportsScheduling ? "true" : undefined}
					data-supports-next-turn-model={
						action.supportsNextTurnModelOverride ? "true" : undefined
					}
					data-pressable="true"
					onclick={() => handleActionClick(action)}
				>
					<span class="action-button-copy">
						<span>{action.label}</span>
						{#if action.supportsScheduling || action.supportsNextTurnModelOverride}
							<span class="action-capability-badges" aria-hidden="true">
								{#if action.supportsScheduling}
									<span class="action-capability-badge" data-action-capability="schedule">
										Later
									</span>
								{/if}
								{#if action.supportsNextTurnModelOverride}
									<span class="action-capability-badge" data-action-capability="model">
										Model
									</span>
								{/if}
							</span>
						{/if}
					</span>
				</button>
			{/each}
		</div>
	{/if}

	{#if externalTriggers.length > 0}
		<section class="external-trigger-card" data-section="external-triggers">
			<p class="external-trigger-heading">
				Events that can continue this process
			</p>
			<ul class="external-trigger-list">
				{#each externalTriggers as trigger (trigger.id)}
					{@const signal = externalTriggerSignalFor(trigger)}
					{@const presentation = signal ? presentExternalTriggerSignal(signal) : null}
					<li class="external-trigger-item" data-external-trigger-id={trigger.id}>
						<div class="external-trigger-header-row">
							<p class="external-trigger-label">{trigger.label}</p>
							{#if presentation}
								<span class={`external-trigger-status ${presentation.tone}`}>{presentation.label}</span>
							{/if}
						</div>
						<p class="external-trigger-description">{trigger.description}</p>
						{#if signal && presentation}
							{#if signal.state === "error"}
								<p class="external-trigger-signal-detail">{presentation.detail}</p>
								{#if signal.secondaryDetail}<p class="external-trigger-signal-secondary">{signal.secondaryDetail}</p>{/if}
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
			{#if externalTriggerSignals.some((signal) => signal.state !== "error")}
				<details class="external-trigger-details">
					<summary>Listener details</summary>
					<dl>
						{#each externalTriggers as trigger (trigger.id)}
							{@const signal = externalTriggerSignalFor(trigger)}
							{#if signal && signal.state !== "error"}
								<div><dt>{trigger.label}</dt><dd>{presentExternalTriggerSignal(signal).detail}{#if signal.secondaryDetail} {signal.secondaryDetail}{/if}</dd></div>
							{/if}
						{/each}
					</dl>
				</details>
			{/if}
		</section>
	{/if}

	{#if actionBindings.actionError}
		<p class="action-error" role="alert">{actionBindings.actionError}</p>
	{/if}

	{#if showOpenActionPanel && openAction}
		<form
			class="action-form"
			data-action-form-id={openAction.id}
			novalidate
			aria-busy={actionBindings.actionBusyId === openAction.id}
			onsubmit={handleActionFormSubmit}
		>
			<div class="action-form-header">
				<div>
					<h4>{openAction.form?.title ?? openAction.label}</h4>
					<p>{describeActionForm(openAction)}</p>
					{#if describeActionPreview(openAction)}
						<p class="action-form-preview" data-section="action-preview-detail">
							{describeActionPreview(openAction)}
						</p>
					{/if}
				</div>
			</div>

			{#if modelConfiguration.availableProfiles.length > 0 && shouldShowActionModelOverride(openAction)}
				{@const actionModelDisplay = getActionModelDisplay(openAction)}
				<div class="action-field-list model-override-list">
					<div class="action-field-group">
						<label class="field-label" for={modelOverrideFieldId(openAction.id)}>
							Next-turn model
						</label>
						<p class="field-description">
							Applies to the next LLM turn this action selects.
						</p>
						<select
							id={modelOverrideFieldId(openAction.id)}
							data-action-form-field
							value={actionBindings.getActionModelOverrideValue(openAction.id)}
							onchange={(event) =>
								actionBindings.setActionModelOverrideValue(
									openAction.id,
									(event.currentTarget as HTMLSelectElement).value,
								)}
						>
							<option value="">
								{actionModelDisplay?.blankOptionLabel ?? "Use selected/default model"}
							</option>
							<ModelProfileOptions profiles={modelConfiguration.availableProfiles} />
						</select>
						{#if actionBindings.openActionModelPreviewLoading && !actionModelDisplay?.helperText}
							<p class="field-note" data-section="action-model-loading">
								Loading the resolved model preview…
							</p>
						{/if}
						{#if actionModelDisplay?.helperText}
							<p
								class:field-error-note={actionModelDisplay.helperTone === "error"}
								class="field-note"
								data-section="action-model-helper"
								data-tone={actionModelDisplay.helperTone}
							>
								{actionModelDisplay.helperText}
							</p>
						{/if}
						{#if actionModelDisplay?.switchCostWarningText}
							<div
								class="field-warning"
								data-section="action-model-switch-warning"
								role="status"
							>
								{actionModelDisplay.switchCostWarningText}
							</div>
						{/if}
					</div>
				</div>
			{/if}

			{#if openAction.supportsScheduling}
				<div class="action-field-list model-override-list">
					<div class="action-field-group">
						<p class="field-label">When to run</p>
						<div class="schedule-choice-row" role="radiogroup" aria-label="When to run">
							<label class="schedule-choice" data-selected={actionBindings.getActionScheduleMode(openAction.id) === "now"}>
								<input
									type="radio"
									name={`schedule-${openAction.id}`}
									checked={actionBindings.getActionScheduleMode(openAction.id) === "now"}
									onchange={() => actionBindings.setActionScheduleMode(openAction.id, "now")}
								/>
								<span>Run now</span>
							</label>
							<label class="schedule-choice" data-selected={actionBindings.getActionScheduleMode(openAction.id) === "once"}>
								<input
									type="radio"
									name={`schedule-${openAction.id}`}
									checked={actionBindings.getActionScheduleMode(openAction.id) === "once"}
									onchange={() => actionBindings.setActionScheduleMode(openAction.id, "once")}
								/>
								<span>Run later</span>
							</label>
						</div>
					</div>
					{#if actionBindings.getActionScheduleMode(openAction.id) === "once"}
						{@const scheduledAtParts = actionBindings.getActionScheduledAtLocalParts(openAction.id)}
						<div class="action-field-group">
							<label class="field-label" for={scheduleRunAtFieldId(openAction.id)}>
								Run at
							</label>
							<ScheduleDateTimePicker
								dateId={scheduleRunAtFieldId(openAction.id)}
								hourId={scheduleRunAtHourFieldId(openAction.id)}
								minuteId={scheduleRunAtMinuteFieldId(openAction.id)}
								dateValue={scheduledAtParts.date}
								hourValue={scheduledAtParts.hour}
								minuteValue={scheduledAtParts.minute}
								dataSection="action-schedule-once-picker"
								marker="action"
								onDateChange={(value) =>
									actionBindings.setActionScheduledAtLocalParts(openAction.id, { date: value })}
								onHourChange={(value) =>
									actionBindings.setActionScheduledAtLocalParts(openAction.id, { hour: value })}
								onMinuteChange={(value) =>
									actionBindings.setActionScheduledAtLocalParts(openAction.id, { minute: value })}
							/>
							<p class="field-description">
								The server stores this in UTC and catches it up after a restart.
							</p>
						</div>
					{/if}
				</div>
			{/if}

			{#if openAction.form}
				<div class="action-field-list">
					{#each openAction.form.fields as field (field.id)}
						<FormFieldRenderer
							{field}
							id={actionBindings.actionFieldDomId(openAction.id, field.id)}
							value={actionBindings.getActionFieldValue(openAction.id, field)}
							errors={getFieldErrors(openAction.id, field.id)}
							descriptionId={actionFieldDescriptionId(openAction.id, field.id)}
							errorId={actionFieldErrorId(openAction.id, field.id)}
							describedBy={getFieldDescribedBy(openAction.id, field)}
							marker="action"
							textareaRows={4}
							onValueChange={(_, value) => setValidatedFieldValue(openAction.id, field, value)}
							onTextBlur={() => actionBindings.commitActionPreview(openAction.id)}
						/>
					{/each}
				</div>
			{/if}

			<div class="action-form-footer">
				<button type="submit" class="primary-button" data-pressable="true" disabled={actionBindings.actionBusyId !== null}>
					{actionBindings.actionBusyId === openAction.id
						? openAction.supportsScheduling && actionBindings.getActionScheduleMode(openAction.id) === "once"
							? "Saving schedule…"
							: "Running action…"
						: openAction.supportsScheduling && actionBindings.getActionScheduleMode(openAction.id) === "once"
							? "Schedule action"
							: openAction.form?.submitLabel ?? openAction.label}
				</button>
			</div>
		</form>
	{/if}
</section>

<style>
	.action-section {
		display: grid;
		gap: var(--space-md);
		padding: var(--space-lg) var(--space-xl);
		margin-inline-start: 0;
		border: 1px solid color-mix(in srgb, var(--chronicle-accent) 30%, var(--chronicle-border) 70%);
		border-radius: 10px;
		background: color-mix(in srgb, white 94%, var(--chronicle-accent-soft) 6%);
		scroll-margin-top: var(--space-xl);
	}

	.action-section[data-action-state="required"] {
		border-color: color-mix(in srgb, var(--chronicle-accent) 40%, var(--chronicle-border) 60%);
		background: color-mix(in srgb, white 91%, var(--chronicle-accent-soft) 9%);
	}

	.action-section.is-focused,
	.action-section.has-open-form {
		border-color: color-mix(in srgb, var(--chronicle-accent) 50%, var(--chronicle-border) 50%);
		background: color-mix(in srgb, white 90%, var(--chronicle-accent-soft) 10%);
	}

	.action-section.is-focused {
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--chronicle-accent) 14%, transparent 86%);
	}

	.action-header {
		display: flex;
		justify-content: space-between;
		gap: var(--space-lg);
		align-items: start;
	}

	.action-header-copy {
		display: grid;
		gap: 6px;
		max-width: 54ch;
	}

	.action-header-controls {
		display: flex;
		gap: var(--space-xs);
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.action-status-row { display: inline-flex; align-items: center; gap: 6px; width: fit-content; color: var(--chronicle-attention); font-size: var(--type-body-sm); font-weight: 600; line-height: 1.4; }

	.action-status-dot {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--chronicle-attention);
	}

	.action-section[data-action-state="external-trigger"] .action-status-row {
		border-color: color-mix(in srgb, var(--chronicle-attention) 32%, var(--chronicle-border) 68%);
		background: color-mix(in srgb, white 88%, var(--chronicle-attention) 12%);
		color: color-mix(in srgb, var(--chronicle-attention) 78%, var(--chronicle-text) 22%);
	}

	.action-section[data-action-state="external-trigger"] .action-status-dot {
		background: var(--chronicle-attention);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--chronicle-attention) 14%, transparent 86%);
	}

	.action-header h3,
	.action-form-header h4 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 16px;
		line-height: 1.22;
		font-weight: 720;
		color: var(--chronicle-text);
	}

	.action-description,
	.action-form-header p,
	.field-description,
	.field-note,
	.action-error {
		margin: 0;
		font-size: 14px;
		line-height: 1.55;
		color: var(--chronicle-text-muted);
	}

	.action-form-preview {
		margin-top: var(--space-xs);
		font-size: var(--type-body-sm);
		line-height: 1.5;
		color: var(--chronicle-text);
	}

	.action-row {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		align-items: stretch;
		gap: var(--space-sm);
	}

	.external-trigger-card {
		display: grid;
		gap: var(--space-sm);
		padding-top: var(--space-md);
		border-top: 1px solid color-mix(in srgb, var(--chronicle-accent) 18%, var(--chronicle-border) 82%);
	}

	.external-trigger-heading,
	.external-trigger-label {
		margin: 0;
	}

	.external-trigger-heading { font-size: var(--type-body-sm); font-weight: 620; color: var(--chronicle-text-muted); }
	.external-trigger-details summary { width: fit-content; padding: var(--space-xs) 0; font-size: var(--type-body-sm); color: var(--chronicle-text-muted); cursor: pointer; }
	.external-trigger-details[open] { padding-bottom: var(--space-xs); }
	.external-trigger-details dl { display: grid; gap: var(--space-sm); margin: var(--space-xs) 0 0; font-size: var(--type-body-sm); line-height: 1.5; color: var(--chronicle-text-muted); }
	.external-trigger-details dt { font-weight: 620; }
	.external-trigger-details dd { margin: 2px 0 0; overflow-wrap: anywhere; }

	.external-trigger-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: var(--space-sm);
	}

	.external-trigger-item {
		display: grid;
		gap: var(--space-xs);
		padding: var(--space-sm) 0;
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 74%, white 26%);
	}

	.external-trigger-item:first-child {
		padding-top: 0;
		border-top: 0;
	}

	.external-trigger-header-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		flex-wrap: wrap;
	}

	.external-trigger-label {
		font-size: 14px;
		font-weight: 620;
		color: var(--chronicle-text);
	}

	.external-trigger-status {
		display: inline-flex;
		align-items: center;
		min-height: 28px;
		padding: 0 10px;
		border-radius: 999px;
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.02em;
		border: 1px solid color-mix(in srgb, var(--chronicle-border-strong) 76%, white 24%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 94%, white 6%);
		color: var(--chronicle-text);
	}

	.external-trigger-status.ready {
		border-color: var(--chronicle-border);
		background: var(--chronicle-panel-muted);
		color: var(--chronicle-text-muted);
	}

	.external-trigger-status.attention {
		border-color: color-mix(in srgb, var(--chronicle-danger) 28%, var(--chronicle-border) 72%);
		background: color-mix(in srgb, white 92%, var(--chronicle-danger) 8%);
		color: var(--chronicle-danger-text);
	}

	.external-trigger-description,
	.external-trigger-signal-detail,
	.external-trigger-signal-secondary {
		margin: 0;
		font-size: 14px;
		line-height: 1.55;
	}

	.external-trigger-description {
		color: var(--chronicle-text-muted);
	}

	.external-trigger-signal-detail {
		color: var(--chronicle-text);
	}

	.external-trigger-signal-secondary {
		color: var(--chronicle-text-muted);
	}

	.action-row button,
	.primary-button,
	.secondary-button,
	.action-field-group input,
	.action-field-group select {
		font: inherit;
	}

	.action-row button,
	.primary-button,
	.secondary-button {
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border-strong) 84%, white 16%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 94%, white 6%);
		color: var(--chronicle-text);
		cursor: pointer;
	}

	.action-row button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2xs);
		min-height: 44px;
		padding: 8px var(--space-md);
		font-size: var(--type-body);
		font-weight: 640;
		line-height: 1.2;
		text-align: center;
	}

	.action-button-copy {
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2xs);
	}

	/* Capability hints describe what an action supports (scheduling, model
	   override). They are annotations, not separate controls, so they are
	   styled as faint micro-labels rather than interactive pills. */
	.action-capability-badges {
		display: none;
		align-items: center;
		gap: var(--space-xs);
	}

	.action-capability-badge {
		display: inline-flex;
		align-items: center;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--chronicle-text-faint);
	}

	.action-capability-badge + .action-capability-badge {
		position: relative;
		padding-inline-start: calc(var(--space-xs) + 1px);
	}

	.action-capability-badge + .action-capability-badge::before {
		content: "";
		position: absolute;
		inset-inline-start: 0;
		top: 50%;
		width: 1px;
		height: 9px;
		transform: translateY(-50%);
		background: color-mix(in srgb, var(--chronicle-text-faint) 50%, transparent 50%);
	}

	.action-row button.active {
		border-color: color-mix(in srgb, var(--chronicle-accent) 26%, var(--chronicle-border-strong) 74%);
		background: color-mix(in srgb, white 92%, var(--chronicle-accent-soft) 8%);
	}

	.action-row button.is-primary-choice {
		border-color: color-mix(in srgb, var(--chronicle-accent) 36%, var(--chronicle-text) 64%);
		background: color-mix(in srgb, var(--chronicle-text) 88%, var(--chronicle-accent) 12%);
		color: var(--chronicle-text-on-accent);
		box-shadow: 0 6px 14px color-mix(in srgb, var(--chronicle-accent) 8%, transparent 92%);
	}

	.action-row button.is-primary-choice.active {
		background: color-mix(in srgb, var(--chronicle-text) 82%, var(--chronicle-accent) 18%);
	}

	.action-row button.is-primary-choice .action-capability-badge {
		color: color-mix(in srgb, var(--chronicle-text-on-accent) 68%, transparent 32%);
	}

	.action-row button.is-primary-choice .action-capability-badge + .action-capability-badge::before {
		background: color-mix(in srgb, var(--chronicle-text-on-accent) 34%, transparent 66%);
	}

	.action-row button:hover,
	.secondary-button:hover,
	.primary-button:hover {
		transform: translateY(-1px);
	}

	.action-row button:disabled,
	.primary-button:disabled,
	.secondary-button:disabled {
		opacity: 0.62;
		cursor: default;
		transform: none;
	}

	.action-error {
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--chronicle-danger) 26%, var(--chronicle-border) 74%);
		background: color-mix(in srgb, white 92%, var(--chronicle-danger) 8%);
		color: var(--chronicle-danger-text);
	}

	.action-form {
		display: grid;
		gap: var(--space-md);
		padding: var(--space-md);
		border: 1px solid color-mix(in srgb, var(--chronicle-accent) 26%, var(--chronicle-border) 74%);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, white 94%, var(--chronicle-accent-soft) 6%);
	}

	.action-form-header {
		display: flex;
		justify-content: space-between;
		gap: var(--space-md);
		align-items: start;
		padding-bottom: var(--space-sm);
		border-bottom: 1px solid color-mix(in srgb, var(--chronicle-accent) 16%, var(--chronicle-border) 84%);
	}

	.secondary-button,
	.primary-button {
		min-height: 44px;
		padding: 0 16px;
		font-size: 14px;
		font-weight: 620;
	}

	.action-form .primary-button {
		min-height: 48px;
		padding-inline: 22px;
		font-weight: 700;
	}

	.primary-button {
		border-color: color-mix(in srgb, var(--chronicle-accent) 28%, var(--chronicle-text) 72%);
		background: color-mix(in srgb, var(--chronicle-text) 86%, white 14%);
		color: var(--chronicle-card-surface);
	}

	.action-field-list {
		display: grid;
		gap: var(--space-sm);
	}

	.model-override-list {
		margin-bottom: var(--space-sm);
	}

	.schedule-choice-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: var(--space-xs);
	}

	.action-field-group {
		display: grid;
		gap: 6px;
	}

	.field-note {
		color: var(--chronicle-text-muted);
	}

	.field-error-note {
		color: var(--chronicle-danger, #b91c1c);
	}

	.field-warning {
		padding: 12px 14px;
		border-radius: 14px;
		border: 1px solid color-mix(in srgb, var(--chronicle-warning, #d97706) 24%, var(--chronicle-border) 76%);
		background: color-mix(in srgb, white 92%, var(--chronicle-warning, #d97706) 8%);
		font-size: 14px;
		line-height: 1.55;
		color: var(--chronicle-text);
	}

	.field-label {
		margin: 0;
		font-size: 14px;
		font-weight: 620;
		color: var(--chronicle-text);
	}

	.action-field-group input,
	.action-field-group select {
		padding: 12px 14px;
		border-radius: 14px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 96%, white 4%);
		color: var(--chronicle-text);
		outline: none;
	}

	.action-form-footer {
		display: flex;
		justify-content: flex-end;
		padding-top: var(--space-sm);
		border-top: 1px solid color-mix(in srgb, var(--chronicle-accent) 14%, var(--chronicle-border) 86%);
	}

	@media (max-width: 720px) {
		.action-section {
			padding: var(--space-lg);
		}

		.action-header {
			flex-direction: column;
		}

		.action-header-controls,
		.action-form-footer,
		.primary-button,
		.secondary-button {
			width: 100%;
		}
	}
</style>

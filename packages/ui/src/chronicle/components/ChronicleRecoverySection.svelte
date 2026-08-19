<script lang="ts">
import type { ModelProfileOptionSummary } from "@leitwerk-dev/protocol";
import ProviderOptionsEditor from "./ProviderOptionsEditor.svelte";
import RecoveryModelControl from "./RecoveryModelControl.svelte";

interface Props {
	anchorId: string;
	instanceId: string;
	isFocused: boolean;
	title: string;
	summary: string;
	guidance?: string;
	technicalDetail?: string | null;
	turnRecordId: string;
	canContinue: boolean;
	supportsModelOverride: boolean;
	continueBusy?: boolean;
	continueError?: string | null;
	continuePrompt?: string;
	retryBusy?: boolean;
	retryError?: string | null;
	modelProfiles?: readonly ModelProfileOptionSummary[];
	defaultModelProfileId?: string | null;
	defaultProviderOptions?: Readonly<Record<string, string>>;
	onContinue: (
		prompt: string,
		nextTurnModelProfileId?: string | null,
		providerOptions?: Readonly<Record<string, string>>,
	) => void;
	onRetry: (
		nextTurnModelProfileId?: string | null,
		providerOptions?: Readonly<Record<string, string>>,
	) => void;
}

let {
	anchorId,
	instanceId,
	isFocused,
	title,
	summary,
	guidance = "Review the latest attempt, then continue from saved work or retry only the failed turn as a new attempt.",
	technicalDetail = null,
	turnRecordId,
	canContinue,
	supportsModelOverride,
	continueBusy = false,
	continueError = null,
	continuePrompt = "",
	retryBusy = false,
	retryError = null,
	modelProfiles = [],
	defaultModelProfileId = null,
	defaultProviderOptions = {},
	onContinue,
	onRetry,
}: Props = $props();

let continuePromptDraft = $state((() => continuePrompt)());
let modelProfileDraft = $state((() => defaultModelProfileId ?? "")());
let providerOptionsDraft = $state<Record<string, string> | undefined>(undefined);

const controlsBusy = $derived(continueBusy || retryBusy);
const continuePromptValid = $derived(continuePromptDraft.trim().length > 0);
const selectedProfile = $derived(
	modelProfiles.find((profile) => profile.id === modelProfileDraft) ?? null,
);
const selectedModelUsable = $derived(
	selectedProfile === null ||
		selectedProfile.availability === undefined ||
		selectedProfile.availability === "available",
);
</script>

<section
	id={anchorId}
	class="recovery-section chronicle-danger-panel"
	class:is-focused={isFocused}
	data-anchor-id={anchorId}
	data-focused={isFocused ? "true" : "false"}
	data-section="current-turn-recovery"
	tabindex="-1"
>
	<div class="recovery-header">
		<div class="recovery-copy">
			<p class="recovery-eyebrow chronicle-danger-eyebrow">Error</p>
			<h3>{title}</h3>
			<p class="recovery-summary">{summary}</p>
			<p class="recovery-guidance">{guidance}</p>
		</div>
	</div>
	{#if technicalDetail}
		<details class="recovery-detail chronicle-danger-detail">
			<summary>Technical details</summary>
			<pre>{technicalDetail}</pre>
		</details>
	{/if}

	<div class="recovery-actions" role="group" aria-label="Recovery actions">
		{#if supportsModelOverride}
			<RecoveryModelControl
				{instanceId}
				{modelProfiles}
				defaultModelProfileId={defaultModelProfileId ?? null}
				initialProviderOptions={defaultProviderOptions}
				disabled={controlsBusy}
				selectId={`recovery-model-${turnRecordId}`}
				selectLabel="Model for the new attempt"
				selectDataField="recovery-model"
				onModelChange={(profileId, _usable) => {
					modelProfileDraft = profileId ?? "";
				}}
				onProviderOptionsChange={(values) =>
					(providerOptionsDraft = values ? { ...values } : undefined)}
			/>
		{/if}
		{#if canContinue}
			<div class="continue-editor">
				<label class="continue-label" for={`continue-prompt-${turnRecordId}`}>Message before continuing</label>
				<textarea
					id={`continue-prompt-${turnRecordId}`}
					class="continue-textarea"
					data-field="continue-prompt"
					rows="4"
					bind:value={continuePromptDraft}
					disabled={controlsBusy}
				></textarea>
				<p class="continue-help">
					Use the suggested message to continue from the saved work, or replace it with a specific instruction for the resumed run.
				</p>
				<button
					type="button"
					class="recovery-button"
					data-action="continue-failed-turn"
					data-turn-record-id={turnRecordId}
					data-pressable="true"
					disabled={controlsBusy || !continuePromptValid || !selectedModelUsable}
					onclick={() =>
						onContinue(
							continuePromptDraft,
							modelProfileDraft || undefined,
							providerOptionsDraft,
						)}
				>
					{continueBusy ? "Continuing…" : "Continue from saved work"}
				</button>
			</div>
		{:else}
			<p class="recovery-note" data-section="continue-unavailable">
				Not enough saved progress is available to continue this attempt.
			</p>
		{/if}

		<button
			type="button"
			class="recovery-button"
			data-action="retry-failed-turn"
			data-turn-record-id={turnRecordId}
			data-pressable="true"
			disabled={controlsBusy || !selectedModelUsable}
			onclick={() => onRetry(modelProfileDraft || undefined, providerOptionsDraft)}
		>
			{retryBusy ? "Retrying failed turn…" : "Retry failed turn"}
		</button>
	</div>

	{#if continueError || retryError}
		<div class="recovery-errors">
			{#if continueError}
				<p class="recovery-error" role="alert">{continueError}</p>
			{/if}
			{#if retryError}
				<p class="recovery-error" role="alert">{retryError}</p>
			{/if}
		</div>
	{/if}
</section>

<style>
	.recovery-header,
	.recovery-copy,
	.recovery-errors {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.recovery-copy h3,
	.recovery-summary,
	.recovery-guidance,
	.recovery-note,
	.recovery-error {
		margin: 0;
	}

	.recovery-summary,
	.recovery-guidance,
	.continue-help {
		max-width: 58ch;
	}

	.recovery-copy h3 {
		font-size: var(--type-heading-sm);
		line-height: 1.2;
		color: var(--chronicle-text);
	}

	.recovery-summary {
		font-size: 14px;
		line-height: 1.5;
		color: var(--chronicle-text);
	}

	.recovery-guidance,
	.recovery-note {
		font-size: 13px;
		line-height: 1.5;
		color: var(--chronicle-text-muted);
	}

	.recovery-detail {
		font-size: 12px;
		color: var(--chronicle-text-muted);
	}

	.recovery-detail > summary {
		cursor: pointer;
		font-weight: 600;
		color: color-mix(in srgb, var(--chronicle-text-muted) 88%, var(--chronicle-text) 12%);
		user-select: none;
	}

	.recovery-detail > summary:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--chronicle-danger) 60%, transparent);
		outline-offset: 2px;
		border-radius: 4px;
	}

	.recovery-actions {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 14px;
		align-items: end;
	}

	.continue-editor {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
		padding: var(--space-md);
		border: 1px solid color-mix(in srgb, var(--chronicle-danger) 24%, var(--chronicle-border) 76%);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, white 92%, var(--chronicle-danger) 8%);
	}

	.continue-label {
		font-size: 13px;
		font-weight: 750;
		letter-spacing: 0.01em;
		color: var(--chronicle-text);
	}

	.continue-textarea {
		width: 100%;
		min-height: 7rem;
		padding: 12px 14px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border-strong) 76%, white 24%);
		border-radius: 14px;
		background: color-mix(in srgb, white 94%, var(--chronicle-card-surface) 6%);
		color: var(--chronicle-text);
		font: inherit;
		line-height: 1.5;
		resize: vertical;
	}

	.continue-help {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--chronicle-text-muted);
	}

	.recovery-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 48px;
		padding: 8px 16px;
		border: 1px solid color-mix(in srgb, var(--chronicle-danger-text) 18%, var(--chronicle-border-strong) 82%);
		border-radius: 999px;
		background: color-mix(in srgb, white 92%, var(--chronicle-card-surface) 8%);
		color: var(--chronicle-text);
		font-size: 14px;
		font-weight: 680;
		cursor: pointer;
		transition:
			background-color 160ms ease,
			border-color 160ms ease,
			transform 160ms ease;
	}

	.continue-editor .recovery-button {
		align-self: flex-start;
		padding-inline: 20px;
		border-color: color-mix(in srgb, var(--chronicle-danger) 28%, var(--chronicle-text) 72%);
		background: color-mix(in srgb, var(--chronicle-text) 88%, var(--chronicle-danger) 12%);
		color: var(--chronicle-text-on-accent);
	}

	.recovery-button:hover:not(:disabled) {
		background: color-mix(in srgb, white 82%, var(--chronicle-danger-text) 18%);
		border-color: color-mix(in srgb, var(--chronicle-danger-text) 28%, var(--chronicle-border-strong) 72%);
		transform: translateY(-1px);
	}

	.continue-editor .recovery-button:hover:not(:disabled) {
		background: color-mix(in srgb, var(--chronicle-text) 82%, var(--chronicle-danger) 18%);
	}

	.recovery-button:disabled {
		opacity: 0.62;
		cursor: default;
		transform: none;
	}

	.recovery-error {
		font-size: 13px;
		line-height: 1.5;
		color: var(--chronicle-danger-text);
	}

	@media (max-width: 720px) {
		.recovery-actions {
			grid-template-columns: 1fr;
		}

		.recovery-button,
		.continue-editor .recovery-button {
			width: 100%;
		}
	}
</style>

<script lang="ts">
import type { ModelProfileOptionSummary } from "@leitwerk-dev/protocol";
import ChronicleEntryHeader from "./ChronicleEntryHeader.svelte";
import ChronicleFailureMessage from "./ChronicleFailureMessage.svelte";
import RecoveryModelControl from "./RecoveryModelControl.svelte";

interface Props {
	anchorId: string;
	embedded?: boolean;
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
	embedded = false,
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

let optionsExpanded = $state(false);
</script>

<section
 id={anchorId}
 class="recovery-section"
 class:is-embedded={embedded}
 class:is-focused={isFocused}
 data-anchor-id={anchorId}
 data-focused={isFocused ? "true" : "false"}
 data-section="current-turn-recovery"
 tabindex="-1"
>
 {#if !embedded}<ChronicleEntryHeader {title} kind="llm" failed />{/if}
 <ChronicleFailureMessage {summary} {technicalDetail} />

 {#if canContinue}
  <div class="continue-editor">
   <label class="continue-label" for={`continue-prompt-${turnRecordId}`}>Message before continuing</label>
   <textarea id={`continue-prompt-${turnRecordId}`} class="continue-textarea" data-field="continue-prompt" rows="3" bind:value={continuePromptDraft} disabled={controlsBusy}></textarea>
   <p class="continue-help">Use the suggested message or add instructions for the resumed run.</p>
   <button type="button" class="recovery-button continue-button" data-action="continue-failed-turn" data-turn-record-id={turnRecordId} data-pressable="true" disabled={controlsBusy || !continuePromptValid || !selectedModelUsable} onclick={() => onContinue(continuePromptDraft, modelProfileDraft || undefined, providerOptionsDraft)}>
    {continueBusy ? "Continuing…" : "Continue from saved work"}
   </button>
  </div>
 {/if}

 <div class="recovery-footer">
  <div class="recovery-note">
   <p>Retry will restart this turn.</p>
   {#if !canContinue}<p class="recovery-guidance" data-section="continue-unavailable">There isn't enough saved progress to resume from the failure point.</p>
   {:else}<p class="recovery-guidance">{guidance}</p>{/if}
  </div>
  <div class="recovery-actions" role="group" aria-label="Recovery actions">
   <button type="button" class="recovery-button" data-action="retry-failed-turn" data-turn-record-id={turnRecordId} data-pressable="true" disabled={controlsBusy || !selectedModelUsable} onclick={() => onRetry(modelProfileDraft || undefined, providerOptionsDraft)}>
    {retryBusy ? "Retrying failed turn…" : "Retry failed turn"}
   </button>
   {#if supportsModelOverride}
    <button type="button" class="recovery-button options-toggle" data-action="toggle-retry-options" aria-expanded={optionsExpanded} aria-controls={`retry-options-${turnRecordId}`} disabled={controlsBusy} onclick={() => optionsExpanded = !optionsExpanded}>
     Retry options
     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d={optionsExpanded ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>
    </button>
   {/if}
  </div>
 </div>

 {#if supportsModelOverride}
  <div class="retry-options" id={`retry-options-${turnRecordId}`} hidden={!optionsExpanded}>
   <RecoveryModelControl
    {instanceId}
    {modelProfiles}
    defaultModelProfileId={defaultModelProfileId ?? null}
    initialProviderOptions={defaultProviderOptions}
    disabled={controlsBusy}
    selectId={`recovery-model-${turnRecordId}`}
    selectLabel="Model for the new attempt"
    selectDataField="recovery-model"
    onModelChange={(profileId, _usable) => { modelProfileDraft = profileId ?? ""; }}
    onProviderOptionsChange={(values) => (providerOptionsDraft = values ? { ...values } : undefined)}
   />
  </div>
 {/if}

 {#if continueError || retryError}
  <div class="recovery-errors">
   {#if continueError}<p class="recovery-error" role="alert">{continueError}</p>{/if}
   {#if retryError}<p class="recovery-error" role="alert">{retryError}</p>{/if}
  </div>
 {/if}
</section>

<style>
 .recovery-section { display: flex; flex-direction: column; gap: 14px; min-width: 0; padding: 14px; border: 1px solid color-mix(in srgb, var(--chronicle-danger) 50%, var(--chronicle-border)); border-radius: 10px; background: color-mix(in srgb, var(--chronicle-danger) 2%, var(--chronicle-card-surface)); scroll-margin-top: 28px; }
 .recovery-section.is-embedded { padding: 0; border: 0; background: transparent; }
 .recovery-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 20px; padding: 0 4px; }
 .recovery-note { flex: 1 1 260px; min-width: 0; }
 .recovery-note p { margin: 0; font-size: var(--type-body-sm); line-height: 1.55; color: var(--chronicle-text); }
 .recovery-note .recovery-guidance { color: var(--chronicle-text-muted); }
 .recovery-actions { display: flex; align-items: center; gap: 10px; }
 .recovery-button { display: inline-flex; align-items: center; justify-content: center; gap: 16px; min-height: 44px; padding: 8px 20px; border: 1px solid var(--chronicle-border-strong); border-radius: 999px; background: var(--chronicle-card-surface); color: var(--chronicle-text); font: inherit; font-size: var(--type-body-sm); font-weight: 650; white-space: nowrap; cursor: pointer; }
 .recovery-button:hover:not(:disabled) { background: var(--chronicle-panel-muted); border-color: var(--chronicle-text-muted); }
 .recovery-button:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 3px; }
 .recovery-button:disabled { opacity: .6; cursor: default; }
 .retry-options { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--chronicle-border); border-radius: 8px; background: var(--chronicle-card-surface); }
 .retry-options[hidden] { display: none; }
 .continue-editor { display: grid; gap: 8px; min-width: 0; }
 .continue-label { font-size: var(--type-body-sm); font-weight: 600; }
 .continue-textarea { width: 100%; min-height: 84px; padding: 10px 12px; border: 1px solid var(--chronicle-border-strong); border-radius: 8px; background: var(--chronicle-card-surface); color: var(--chronicle-text); font: inherit; font-size: var(--type-body-sm); line-height: 1.5; resize: vertical; }
 .continue-help { margin: 0; color: var(--chronicle-text-muted); font-size: var(--type-caption); line-height: 1.5; }
 .continue-button { justify-self: start; background: var(--chronicle-text); color: var(--chronicle-text-on-accent); }
 .continue-button:hover:not(:disabled) { background: color-mix(in srgb, var(--chronicle-text) 85%, var(--chronicle-accent)); }
 .recovery-error { margin: 0; font-size: var(--type-body-sm); line-height: 1.5; color: var(--chronicle-danger-text); }
 @media (max-width: 540px) {
  .recovery-section:not(.is-embedded) { padding: 10px; }
  .recovery-footer { padding: 0; }
  .recovery-actions { width: 100%; gap: 8px; }
  .recovery-button { flex: 1; padding-inline: 12px; gap: 8px; }
 }
</style>

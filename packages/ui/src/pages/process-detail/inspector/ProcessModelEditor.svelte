<script lang="ts">
import type {
	ProcessModelConfigPatch,
	ProcessModelConfigurationView,
} from "@leitwerk-dev/protocol/http-contracts";
import { tick } from "svelte";
import { type ProcessDetailData, updateProcessModelConfig } from "../../../lib/api.js";
import { loadProcessDetail } from "../../../lib/processes.svelte.js";
import { modelSourceLabel as sourceLabel } from "./model-source-label.js";

let { detail }: { detail: ProcessDetailData } = $props();
let editing = $state(false);
let saving = $state(false);
let previewing = $state(false);
let error = $state("");
let notice = $state("");
let defaultValue = $state("");
let turnValues = $state<Record<string, string>>({});
let baseline = $state<ProcessModelConfigurationView | null>(null);
let preview = $state<ProcessModelConfigurationView | null>(null);
let editButton = $state<HTMLButtonElement>();
let defaultSelect = $state<HTMLSelectElement>();
let revision = 0;
const configuration = $derived(preview ?? detail.modelConfiguration);
const editable = $derived(
	!["completed", "aborted"].includes(detail.process.lifecycleStatus) &&
		detail.modelConfiguration.state.kind === "ready",
);
const patch = $derived.by((): ProcessModelConfigPatch => {
	const turnConfigs = Object.fromEntries(
		Object.entries(turnValues)
			.filter(
				([id, value]) =>
					value !==
					(baseline?.turns.find((turn) => turn.turnId === id)?.instanceModelProfileId ?? ""),
			)
			.map(([id, value]) => [id, { modelProfileId: value || null }]),
	);
	return {
		...(defaultValue !== (baseline?.defaultModel.instanceModelProfileId ?? "")
			? { defaultModelProfileId: defaultValue || null }
			: {}),
		...(Object.keys(turnConfigs).length ? { turnConfigs } : {}),
	};
});
const dirty = $derived(Object.keys(patch).length > 0);
async function begin() {
	baseline = detail.modelConfiguration;
	defaultValue = baseline.defaultModel.instanceModelProfileId ?? "";
	turnValues = Object.fromEntries(
		baseline.turns.map((turn) => [turn.turnId, turn.instanceModelProfileId ?? ""]),
	);
	preview = null;
	error = "";
	notice = "";
	editing = true;
	await tick();
	defaultSelect?.focus();
}
async function cancel() {
	revision++;
	editing = false;
	preview = null;
	error = "";
	previewing = false;
	await tick();
	editButton?.focus();
}
async function refreshPreview() {
	const current = ++revision;
	error = "";
	previewing = true;
	try {
		const result = await updateProcessModelConfig(detail.process.id, patch, true);
		if (current === revision) preview = result.modelConfiguration;
	} catch (cause) {
		if (current === revision)
			error = cause instanceof Error ? cause.message : "Couldn't preview model settings";
	} finally {
		if (current === revision) previewing = false;
	}
}
async function save() {
	if (saving || !editable) return;
	saving = true;
	error = "";
	try {
		await updateProcessModelConfig(detail.process.id, patch);
		await loadProcessDetail(detail.process.id);
		await cancel();
		notice = "Model settings saved. Future executions will use these settings.";
	} catch (cause) {
		error =
			cause instanceof Error
				? cause.message
				: "Couldn't save model settings. Your draft is retained.";
	} finally {
		saving = false;
	}
}
</script>
<div class="model-settings">
 <p class="note">Changes apply to future executions and inherited scheduled actions. The current execution keeps its model.</p>
 <p class="note">Default at creation: {detail.process.initialDefaultModelProfileId ?? "Not recorded"}</p>
 {#if detail.modelConfiguration.state.kind === "blocked"}
  <p role="alert">Saved model configuration is malformed and must be repaired before editing.</p>
 {:else if editing}
  <form onchange={refreshPreview} onsubmit={event => { event.preventDefault(); void save(); }}>
   <fieldset disabled={saving || !editable}>
    <div class="model-field">
     <label for="instance-default-model">Default profile</label>
     <select id="instance-default-model" bind:this={defaultSelect} bind:value={defaultValue}>
      <option value="">Inherit process or catalog default</option>
      {#each detail.modelConfiguration.availableProfiles as option (option.id)}<option value={option.id} disabled={option.availability !== "available"}>{option.label}{option.availability !== "available" ? ` · ${option.availability}` : ""}</option>{/each}
     </select>
     <p class="note">Effective default: {configuration.defaultModel.effectiveModelProfileId ?? "Not configured"}</p>
    </div>
    <p class="note">Clearing a step override restores its configured step model, then the instance default.</p>
    {#each configuration.turns as turn (turn.turnId)}
     <div class="model-field">
      {#if turn.fixedModelProfileId}
       <span>{turn.description}</span><p>{turn.fixedModelProfileId}</p><p class="note">Fixed system model. This step cannot be overridden.</p>
      {:else}
       <label for={`step-model-${turn.turnId}`}>{turn.description}</label>
       <select id={`step-model-${turn.turnId}`} bind:value={turnValues[turn.turnId]}>
        <option value="">Inherit configured step model or default</option>
        {#each detail.modelConfiguration.availableProfiles as option (option.id)}<option value={option.id} disabled={option.availability !== "available"}>{option.label}{option.availability !== "available" ? ` · ${option.availability}` : ""}</option>{/each}
       </select>
       <p class="note">{turn.effectiveModelProfileId ?? turn.effectiveConfiguredModelProfileId ?? configuration.defaultModel.effectiveModelProfileId ?? "Not configured"} · {sourceLabel(turn.effectiveSource ?? turn.source)}</p>
      {/if}
     </div>
    {/each}
   </fieldset>
   {#if !editable}<p role="status">This process is now read-only. Your draft has not been saved.</p>{/if}
   <div class="actions"><button class="ui-button" type="submit" disabled={saving || previewing || !dirty || !editable}>{saving ? "Saving…" : "Save changes"}</button><button class="ui-button" type="button" disabled={saving} onclick={cancel}>Cancel</button><span class="note" role="status">{previewing ? "Updating preview…" : ""}</span></div>
  </form>
 {:else}
  <dl><div><dt>Current default</dt><dd>{configuration.defaultModel.effectiveModelProfileId ?? "Not configured"}</dd></div>
   {#each configuration.turns as turn (turn.turnId)}<div><dt>{turn.description}</dt><dd>{turn.effectiveModelProfileId ?? turn.effectiveConfiguredModelProfileId ?? configuration.defaultModel.effectiveModelProfileId ?? "Not configured"}<span class="note"> · {turn.fixedModelProfileId ? "Fixed system model" : sourceLabel(turn.effectiveSource ?? turn.source)}</span></dd></div>{/each}
  </dl>
  {#if editable}<button class="ui-button" bind:this={editButton} onclick={begin}>Edit models</button>{/if}
 {/if}
 {#if error}<p role="alert">{error}</p>{/if}
 <p role="status">{notice}</p>
</div>
<style>
.model-settings,form,fieldset {display:grid; gap:var(--space-md); min-width:0;}
fieldset {padding:0; margin:0; border:0;}
.model-field {display:grid; gap:var(--space-xs); min-width:0;}
label {font-weight:600;} p,dd,dl {margin:0;}
p,dl,label,select {font-size:var(--type-body-sm); line-height:1.6;}
.note,dt {color:var(--chronicle-text-muted);}
select {width:100%; min-width:0; padding:var(--space-sm); color:var(--chronicle-text); background:var(--chronicle-panel-surface); border:1px solid var(--chronicle-border); border-radius:var(--radius-sm);}
select:focus-visible {outline:2px solid var(--chronicle-accent); outline-offset:2px;}
select:disabled {opacity:0.65;}
dl {display:grid; gap:var(--space-md);} dl > div {display:grid; grid-template-columns:minmax(120px,1fr) 2fr; gap:var(--space-md);}
.actions {display:flex; gap:var(--space-sm); flex-wrap:wrap; align-items:center;}
.ui-button {justify-self:start;}
@media(max-width:720px) {dl > div {grid-template-columns:1fr; gap:var(--space-xs);}}
</style>

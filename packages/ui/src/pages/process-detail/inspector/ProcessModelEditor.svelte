<script lang="ts">
import type {
	ProcessModelConfigPatch,
	ProcessModelConfigurationView,
} from "@leitwerk-dev/protocol/http-contracts";
import { tick } from "svelte";
import { type ProcessDetailData, updateProcessModelConfig } from "../../../lib/api.js";
import { loadProcessDetail } from "../../../lib/processes.svelte.js";

let { detail }: { detail: ProcessDetailData } = $props();
let editing = $state(false);
let saving = $state(false);
let previewing = $state(false);
let error = $state("");
let notice = $state("");
let patch = $state<ProcessModelConfigPatch>({});
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
const dirty = $derived(
	Object.hasOwn(patch, "defaultModelProfileId") || Object.keys(patch.turnConfigs ?? {}).length > 0,
);
const defaultValue = $derived(
	Object.hasOwn(patch, "defaultModelProfileId")
		? (patch.defaultModelProfileId ?? "")
		: (baseline?.defaultModel.instanceModelProfileId ?? ""),
);
function turnValue(id: string) {
	return Object.hasOwn(patch.turnConfigs ?? {}, id)
		? (patch.turnConfigs?.[id]?.modelProfileId ?? "")
		: (baseline?.turns.find((turn) => turn.turnId === id)?.instanceModelProfileId ?? "");
}
function sourceLabel(source: string) {
	return (
		(
			{
				instance: "Instance override",
				instance_turn_config: "Instance override",
				process_config_turn: "Configured step model",
				instance_default: "Inherits instance default",
				process_config_default: "Inherits process default",
				none: "Not configured",
				process_config: "Configured step model",
				default: "Inherits the default",
				catalog_default: "Catalog default",
			} as Record<string, string>
		)[source] ?? source
	);
}
async function begin() {
	baseline = detail.modelConfiguration;
	preview = null;
	patch = {};
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
	patch = {};
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
function changeDefault(value: string) {
	const next = { ...patch };
	if ((baseline?.defaultModel.instanceModelProfileId ?? "") === value)
		delete next.defaultModelProfileId;
	else next.defaultModelProfileId = value || null;
	patch = next;
	void refreshPreview();
}
function changeTurn(id: string, value: string) {
	const turns = { ...patch.turnConfigs };
	if ((baseline?.turns.find((turn) => turn.turnId === id)?.instanceModelProfileId ?? "") === value)
		delete turns[id];
	else turns[id] = { modelProfileId: value || null };
	patch = { ...patch, turnConfigs: turns };
	void refreshPreview();
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
  <form onsubmit={event => { event.preventDefault(); void save(); }}>
   <fieldset disabled={saving || !editable}>
    <div class="model-field">
     <label for="instance-default-model">Default profile</label>
     <select id="instance-default-model" bind:this={defaultSelect} value={defaultValue} onchange={event => changeDefault(event.currentTarget.value)}>
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
       <select id={`step-model-${turn.turnId}`} value={turnValue(turn.turnId)} onchange={event => changeTurn(turn.turnId, event.currentTarget.value)}>
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

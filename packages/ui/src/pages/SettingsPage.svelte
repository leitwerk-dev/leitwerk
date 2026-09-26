<script lang="ts">
import type {
	SettingsPreview,
	SettingsScopesResponse,
} from "@leitwerk-dev/protocol/http-contracts";
import { onMount } from "svelte";
import SettingsField from "../components/SettingsField.svelte";
import { fetchSettingsPreview, fetchSettingsScopes } from "../lib/settings.js";

let { subjectId = "instance" }: { subjectId?: string } = $props();
let selected = $state(subjectId);
let scopes = $state<SettingsScopesResponse | null>(null);
let preview = $state<SettingsPreview | null>(null);
let loading = $state(true);
let error = $state("");
let loadId = 0;
const groups = $derived([...new Set(preview?.fields.map((field) => field.form.group) ?? [])]);
async function load(id = selected, background = false) {
	const token = ++loadId;
	if (!background) loading = true;
	error = "";
	if (preview?.subject.id !== id) preview = null;
	try {
		const result = await fetchSettingsPreview(id);
		if (token === loadId) preview = result;
	} catch (caught) {
		if (token === loadId)
			error = caught instanceof Error ? caught.message : "Could not load settings";
	} finally {
		if (token === loadId) loading = false;
	}
}
async function refresh() {
	try {
		scopes = await fetchSettingsScopes(true);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : "Could not refresh repositories";
	}
}
onMount(() => {
	void fetchSettingsScopes()
		.then((result) => {
			scopes = result;
		})
		.catch((caught: unknown) => {
			error = String(caught);
		});
	void load();
	const refreshPreview = () => {
		void load(selected, true);
	};
	window.addEventListener("leitwerk:settings-changed", refreshPreview);
	return () => {
		loadId++;
		window.removeEventListener("leitwerk:settings-changed", refreshPreview);
	};
});
</script>

<div class="settings-page">
	<header><h1>Settings</h1><p>Defaults shared across this installation. Changes apply when a new step is prepared, including operator retries.</p></header>
	<div class="scope-controls"><div><label for="settings-scope">Apply settings to</label><select id="settings-scope" bind:value={selected} onchange={() => load(selected)}>
		{#if !scopes}<option value={selected}>{selected === "instance" ? "Instance" : "Loading scope…"}</option>{/if}
		{#each scopes?.subjects ?? [] as subject (subject.id)}<option value={subject.id}>{subject.scopeType === "instance" ? "Instance" : `${subject.label}${subject.active ? "" : " (inactive)"}`}</option>{/each}
	</select></div><button type="button" onclick={refresh}>Refresh repositories</button></div>
	{#if error}<p role="alert" class="error">{error}</p><button type="button" onclick={() => load()}>Try again</button>{/if}
	{#if loading}<p role="status">Loading settings…</p>
	{:else if preview}
		{#key preview.subject.id}
			{#each groups as group}<section class="purpose" aria-label={group}><h2>{group}</h2>{#each preview.fields.filter((field) => field.form.group === group) as field (field.key)}<SettingsField {field} subjectId={preview.subject.id} onSaved={(result) => { preview = result; }} />{/each}</section>{/each}
		{/key}
		{#if !preview.fields.length && !preview.inactive.length}<p>No installed extension declares settings for this scope.</p>{/if}
		{#if preview.inactive.length}<section class="purpose"><h2>Inactive settings</h2><p>These saved overrides are retained. Install their owning extensions to use or edit them.</p>{#each preview.inactive as override}<div class="inactive"><strong>{override.key}</strong><pre>{typeof override.value === "string" ? override.value : JSON.stringify(override.value, null, 2)}</pre><span>Revision {override.revision}</span></div>{/each}</section>{/if}
	{/if}
</div>

<style>
.settings-page { width: min(100%, 860px); margin: 0 auto; padding: clamp(1rem, 4vw, 2.5rem); color: var(--chronicle-text); }
h1 { margin: 0; font-size: var(--type-title-lg); }
h2 { margin: 0 0 .75rem; font-size: var(--type-title-sm); }
header p, .purpose > p { color: var(--chronicle-text-muted); max-width: 65ch; line-height: 1.6; }
.scope-controls { display: flex; align-items: flex-end; gap: .75rem; margin: 1.5rem 0 2rem; }
.scope-controls > div { flex: 1; min-width: 0; }
label { display: block; margin-bottom: .5rem; font-weight: 600; }
select, button { min-height: 44px; padding: .65rem .8rem; border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-sm); background: var(--chronicle-panel-surface); color: var(--chronicle-text); font: inherit; }
select { width: 100%; }
button { cursor: pointer; }
button:hover { background: var(--chronicle-panel-muted); }
button:focus-visible, select:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 3px; }
.purpose { margin: 2rem 0; }
.error { color: var(--chronicle-danger); }
.inactive { padding: 1rem 0; border-top: 1px solid var(--chronicle-border); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 600px) { .scope-controls { align-items: stretch; flex-direction: column; } }
</style>

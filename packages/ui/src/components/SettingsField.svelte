<script lang="ts">
import type { ResolvedSetting } from "@leitwerk-dev/domain";
import type { SettingFieldView, SettingsPreview } from "@leitwerk-dev/protocol/http-contracts";
import { tick } from "svelte";
import {
	changeSettings,
	fetchSettingsPreview,
	type SettingsChange,
	SettingsRequestError,
} from "../lib/settings.js";

let {
	field,
	subjectId,
	onSaved,
}: { field: SettingFieldView; subjectId: string; onSaved: (preview: SettingsPreview) => void } =
	$props();
let editing = $state(false);
let search = $state("");
let value = $state<unknown>(null);
let mode = $state<"append" | "replace">("replace");
let revision = $state(0);
let busy = $state(false);
let error = $state("");
let notice = $state("");
let conflict = $state(false);
let combined = $state<ResolvedSetting | null>(null);
let previewError = $state("");
const inputId = $derived(`setting-${subjectId}-${field.key}`);
const instructions = $derived(field.merge === "instructions");
const activeOverride = $derived(field.override && !field.override.reset ? field.override : null);
const selected = $derived(
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [],
);
const selectionChoices = $derived([
	...selected
		.filter((value) => !field.choices.some((choice) => choice.value === value))
		.map((value) => ({ value, label: `${value} (unavailable)`, disabledReason: undefined })),
	...field.choices,
]);
const visibleChoices = $derived(
	selectionChoices.filter(
		(choice) =>
			selected.includes(choice.value) || choice.label.toLowerCase().includes(search.toLowerCase()),
	),
);
function toggleChoice(choice: string, checked: boolean) {
	value = checked
		? [...new Set([...selected, choice])]
		: selected.filter((entry) => entry !== choice);
}
function formatSelection(raw: unknown) {
	return Array.isArray(raw)
		? raw
				.map(
					(value) =>
						field.choices.find((choice) => choice.value === value)?.label ??
						`${value} (unavailable)`,
				)
				.join("; ") || "None selected"
		: format(raw);
}
const format = (raw: unknown) =>
	raw === null
		? "Runtime default (YAML or model catalog)"
		: raw === ""
			? "Empty"
			: typeof raw === "string"
				? raw
				: JSON.stringify(raw);
const sources = (resolved: ResolvedSetting | null) =>
	resolved?.sources.map((source) => source.label).join(" → ") ?? "Unavailable";

async function begin() {
	search = "";
	value = activeOverride
		? activeOverride.value
		: instructions
			? ""
			: (field.effective?.value ?? null);
	mode = activeOverride?.mode ?? (instructions ? "append" : "replace");
	revision = field.override?.revision ?? 0;
	error = "";
	notice = "";
	conflict = false;
	editing = true;
	combined = null;
	previewError = "";
	await tick();
	document.getElementById(inputId)?.focus();
}
async function cancel() {
	editing = false;
	error = "";
	await tick();
	document.getElementById(`${inputId}-edit`)?.focus();
}
function change(reset = false): SettingsChange {
	return { subjectId, key: field.key, value, mode, reset, expectedRevision: revision };
}
$effect(() => {
	if (!editing) return;
	const draft = change();
	let current = true;
	const timer = setTimeout(() => {
		void changeSettings(draft, true)
			.then((result) => {
				if (!current) return;
				const updated = result.fields.find((candidate) => candidate.key === field.key);
				combined = updated?.effective ?? null;
				previewError = updated?.error ?? "";
			})
			.catch((caught: unknown) => {
				if (current)
					previewError = caught instanceof Error ? caught.message : "Could not preview setting";
			});
	}, 250);
	return () => {
		current = false;
		clearTimeout(timer);
	};
});
async function save(reset = false) {
	if (busy) return;
	if (!editing) revision = field.override?.revision ?? 0;
	const draft = change(reset);
	const notifySaved = onSaved;
	busy = true;
	error = "";
	notice = "";
	try {
		const result = await changeSettings(draft);
		notifySaved(result);
		editing = false;
		conflict = false;
		notice = reset ? "Inherited value restored." : "Saved. Future steps will use this setting.";
		window.dispatchEvent(new Event("leitwerk:settings-changed"));
		busy = false;
		await tick();
		document.getElementById(`${inputId}-edit`)?.focus();
	} catch (caught) {
		error =
			caught instanceof Error ? caught.message : "Could not save setting. Your draft is preserved.";
		conflict = caught instanceof SettingsRequestError && caught.status === 409;
		if (conflict) {
			try {
				notifySaved(await fetchSettingsPreview(draft.subjectId));
			} catch {
				/* Keep the draft and original error. */
			}
		}
	} finally {
		busy = false;
	}
}
async function useLatestRevision() {
	revision = field.override?.revision ?? 0;
	conflict = false;
	error = "";
	await tick();
	document.getElementById(inputId)?.focus();
}
</script>

<section class="setting-field" aria-labelledby={`${inputId}-heading`}>
	<div class="field-heading">
		<div><h3 id={`${inputId}-heading`}>{field.form.label}</h3>{#if field.form.description}<p class="description">{field.form.description}</p>{/if}</div>
		{#if !editing}<button id={`${inputId}-edit`} type="button" onclick={begin} disabled={busy}>{activeOverride ? "Edit override" : "Override"}</button>{/if}
	</div>
	<div class="effective"><span class="source">Effective value · {sources(field.effective)}</span><p class:instruction-value={instructions}>{field.effective ? (field.form.control === "multiselect" ? formatSelection(field.effective.value) : format(field.effective.value)) : "Unavailable"}</p></div>
	{#if field.error}<p class="error" role="alert">{field.error}</p>{/if}
	{#if editing}
		<form onsubmit={(event) => { event.preventDefault(); void save(); }}>
			{#if instructions}
				<label for={`${inputId}-mode`}>Instruction behavior</label>
				<select id={`${inputId}-mode`} bind:value={mode} disabled={busy}>
					<option value="append">Add to inherited instructions</option><option value="replace">Replace inherited instructions</option>
				</select>
			{/if}
			<label for={inputId}>{field.form.label} override</label>
			{#if field.form.control === "multiselect"}
				<input id={inputId} type="search" placeholder="Search options" bind:value={search} disabled={busy} aria-describedby={`${inputId}-count`} />
				<p id={`${inputId}-count`} class="source" aria-live="polite">{selected.length} selected</p>
				<div class="choices" role="group" aria-label={field.form.label}>
					{#each visibleChoices as choice (choice.value)}
						<label class="choice"><input type="checkbox" checked={selected.includes(choice.value)} disabled={busy || (Boolean(choice.disabledReason) && !selected.includes(choice.value))} onchange={(event) => toggleChoice(choice.value, event.currentTarget.checked)} /><span>{choice.label}{choice.disabledReason ? ` — ${choice.disabledReason}` : ""}</span></label>
					{:else}<p class="description">No matching options. Refresh this scope to discover available repositories.</p>{/each}
				</div>
			{:else if field.form.control === "model" || field.form.control === "select"}
				<select id={inputId} value={String(value ?? "")} onchange={(event) => { value = event.currentTarget.value || (field.form.control === "model" ? null : ""); }} disabled={busy}>
					{#if field.form.control === "model"}<option value="">Use YAML / catalog default</option>{/if}
					{#if typeof value === "string" && !field.choices.some((choice) => choice.value === value)}<option value={value}>{value} (unavailable)</option>{/if}
					{#each field.choices as choice (choice.value)}<option value={choice.value} disabled={Boolean(choice.disabledReason)}>{choice.label}{choice.disabledReason ? ` — ${choice.disabledReason}` : ""}</option>{/each}
				</select>
			{:else if field.form.control === "textarea"}
				<textarea id={inputId} rows="6" value={String(value ?? "")} oninput={(event) => { value = event.currentTarget.value; }} disabled={busy}></textarea>
			{:else if field.form.control === "checkbox"}
				<input id={inputId} type="checkbox" checked={Boolean(value)} onchange={(event) => { value = event.currentTarget.checked; }} disabled={busy} />
			{:else if field.form.control === "number"}
				<input id={inputId} type="number" value={Number(value)} oninput={(event) => { value = event.currentTarget.valueAsNumber; }} disabled={busy} />
			{:else}
				<input id={inputId} type="text" value={String(value ?? "")} oninput={(event) => { value = event.currentTarget.value; }} disabled={busy} />
			{/if}
			{#if instructions}<div class="combined"><span class="source">Combined preview</span><p class="instruction-value">{format(combined?.value ?? "")}</p></div>{/if}
			{#if previewError}<p class="error">{previewError}</p>{/if}
			<div class="actions"><button class="save" type="submit" disabled={busy || conflict}>{busy ? "Saving…" : "Save override"}</button><button type="button" onclick={cancel} disabled={busy}>Cancel</button></div>
		</form>
	{/if}
	{#if activeOverride}<button class="inherit" type="button" onclick={() => save(true)} disabled={busy || conflict}>Use inherited value</button>{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if conflict}<p>Current saved value: {format(field.override?.value)}. Compare it with your draft above.</p><button type="button" onclick={useLatestRevision} disabled={busy}>Keep draft and use latest revision</button>{/if}
	{#if notice}<p class="notice" role="status">{notice}</p>{/if}
</section>

<style>
.setting-field { padding: 1.4rem 0; border-top: 1px solid var(--chronicle-border); }
.field-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
h3 { margin: 0; font-size: var(--type-body-lg); }
p { margin: .5rem 0; line-height: 1.5; overflow-wrap: anywhere; }
.description { color: var(--chronicle-text-muted); max-width: 65ch; font-size: var(--type-body-sm); }
.source { color: var(--chronicle-text-muted); font-size: var(--type-caption); }
.effective { margin-top: .75rem; }
.effective p { margin-top: .25rem; }
.instruction-value { white-space: pre-wrap; }
form { margin: 1rem 0; display: grid; gap: .65rem; }
label { font-weight: 600; }
input:not([type="checkbox"]), select, textarea { width: 100%; min-width: 0; border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-sm); padding: .7rem; background: var(--chronicle-panel-surface); color: var(--chronicle-text); font: inherit; }
textarea { resize: vertical; }
.combined { padding: .8rem; background: var(--chronicle-panel-muted); border-radius: var(--radius-sm); }
button { min-height: 44px; padding: .5rem .85rem; border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-sm); background: var(--chronicle-panel-surface); color: var(--chronicle-text); font: inherit; cursor: pointer; }
button:hover:not(:disabled) { background: var(--chronicle-panel-muted); }
button:disabled { opacity: .6; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 3px; }
.save { background: var(--chronicle-accent); color: var(--chronicle-text-on-accent); border-color: var(--chronicle-accent); }
.save:hover:not(:disabled) { background: color-mix(in srgb, var(--chronicle-accent) 85%, black); }
.actions { display: flex; gap: .6rem; flex-wrap: wrap; }
.choices { max-height: 20rem; overflow-y: auto; border-block: 1px solid var(--chronicle-border); }
.choice { display: flex; align-items: center; gap: .75rem; min-height: 44px; padding: .6rem .2rem; font-weight: 400; cursor: pointer; }
.choice span { min-width: 0; overflow-wrap: anywhere; }
.choice input { flex: 0 0 auto; accent-color: var(--chronicle-accent); }
.choice:hover { background: var(--chronicle-panel-muted); }
.inherit { margin-top: .5rem; }
.error { color: var(--chronicle-danger); }
.notice { color: var(--chronicle-success); }
@media (max-width: 600px) { .field-heading { flex-direction: column; gap: .5rem; } }
</style>

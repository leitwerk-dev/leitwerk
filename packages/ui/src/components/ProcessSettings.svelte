<script lang="ts">
import type { ResolvedSetting, ScopedSettingsSnapshot } from "@leitwerk-dev/domain";
import { onMount, tick } from "svelte";
import {
	bindPrimaryRepository,
	fetchProcessSettings,
	type ProcessSettingsView,
	SettingsRequestError,
	settingsPath,
} from "../lib/settings.js";

let { instanceId, refreshVersion }: { instanceId: string; refreshVersion?: string } = $props();
let data = $state<ProcessSettingsView | null>(null);
let error = $state("");
let primary = $state("");
let busy = $state(false);
let dirty = $state(false);
let expectedPrimary = $state<string | null>(null);
let conflict = $state(false);
let notice = $state("");
let loadId = 0;
let alive = true;
const source = (setting: ResolvedSetting) =>
	setting.sources
		.map((item) => `${item.label}${item.revision ? ` (revision ${item.revision})` : ""}`)
		.join(" → ");
async function load() {
	const token = ++loadId;
	try {
		const result = await fetchProcessSettings(instanceId);
		if (alive && token === loadId) {
			data = result;
			if (!dirty) {
				primary = result.primaryRepositoryKey ?? "";
				expectedPrimary = result.primaryRepositoryKey;
			}
		}
	} catch (caught) {
		if (alive && token === loadId)
			error = caught instanceof Error ? caught.message : "Could not load settings";
	}
}
$effect(() => {
	refreshVersion;
	void load();
});
onMount(() => {
	const refresh = () => {
		void load();
	};
	window.addEventListener("leitwerk:settings-changed", refresh);
	return () => {
		alive = false;
		window.removeEventListener("leitwerk:settings-changed", refresh);
	};
});
async function bind() {
	if (!data) return;
	busy = true;
	error = "";
	try {
		await bindPrimaryRepository(instanceId, primary || null, expectedPrimary);
		dirty = false;
		conflict = false;
		notice = "Primary repository saved. Future steps will use these defaults.";
		await load();
		window.dispatchEvent(new Event("leitwerk:settings-changed"));
	} catch (caught) {
		error = caught instanceof Error ? caught.message : "Could not bind primary repository";
		conflict = caught instanceof SettingsRequestError && caught.status === 409;
		if (conflict) await load();
	} finally {
		busy = false;
	}
}
</script>

{#snippet snapshot(value: ScopedSettingsSnapshot)}
	<dl>{#each value.values as setting}<dt>{setting.key}</dt><dd>{setting.value === null ? "YAML / catalog default" : String(setting.value)} <span>from {source(setting)}</span></dd>{/each}</dl>
	{#each value.instructions as block}<details><summary>{block.label} · Instructions</summary><p class="source">{source(block.setting)}</p><pre>{block.setting.value || "No instructions"}</pre></details>{/each}
{/snippet}

<section class="process-settings">
	<h3>Scoped settings</h3><p><a href={settingsPath()}>Edit instance defaults</a>{#each data?.repositories ?? [] as repository} · <a href={settingsPath(repository.subjectId)}>{repository.key} settings</a>{/each}</p>
	{#if error}<p role="alert">{error}</p>{/if}
	{#if data}
		{#each data.explanations as explanation}<p>{explanation}</p>{/each}
		{#if data.repositories.length > 1}<form onsubmit={(event) => { event.preventDefault(); void bind(); }}><label for="primary-settings-repository">Primary repository for model defaults</label><select id="primary-settings-repository" bind:value={primary} onchange={() => { dirty = true; notice = ""; }} disabled={busy}><option value="">Use Instance settings</option>{#each data.repositories as repository}<option value={repository.key}>{repository.key}</option>{/each}</select><button type="submit" disabled={busy || conflict}>Save primary repository</button></form>{/if}
		{#if conflict}<p>Current saved primary repository: {data.primaryRepositoryKey ?? "Instance settings"}. Your selection is preserved.</p><button type="button" disabled={busy} onclick={async () => { expectedPrimary = data?.primaryRepositoryKey ?? null; conflict = false; error = ""; await tick(); document.getElementById("primary-settings-repository")?.focus(); }}>Keep selection and use latest binding</button>{/if}
		{#if notice}<p role="status">{notice}</p>{/if}
		<details><summary>Defaults for future steps</summary><p>Current scoped defaults. Explicit model choices on the process or action take precedence.</p>{#each data.future as future}<details><summary>{future.turnId}</summary>{#if future.error}<p role="alert">{future.error}</p>{:else if future.settings}{@render snapshot(future.settings)}{/if}</details>{/each}</details>
		<details><summary>Captured settings · {data.captured.length} prepared steps</summary><p>Values retained for each prepared start, including recovery.</p>{#each data.captured as captured}<details><summary>{captured.turnId} · {new Date(captured.createdAt).toLocaleString()} · {captured.state}</summary>{@render snapshot(captured.settings)}</details>{:else}<p>No settings have been captured for this process yet.</p>{/each}</details>
	{/if}
</section>

<style>
.process-settings { margin: 1.5rem 0; border-top: 1px solid var(--chronicle-border); padding-top: 1.5rem; }
h3 { margin: 0 0 .5rem; font-size: var(--type-title-sm); }
p { line-height: 1.5; }
a { color: var(--chronicle-link); text-underline-offset: 3px; }
details { margin: .8rem 0; }
details details { margin-left: .75rem; }
summary { cursor: pointer; min-height: 44px; padding-block: .6rem; }
summary:focus-visible, a:focus-visible, button:focus-visible, select:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 3px; }
pre, dd { white-space: pre-wrap; overflow-wrap: anywhere; }
dt { font-weight: 600; margin-top: .65rem; overflow-wrap: anywhere; }
dd { margin: .25rem 0; }
dd span, .source { color: var(--chronicle-text-muted); }
form { display: grid; gap: .65rem; margin: 1rem 0; }
select, button { min-height: 44px; padding: .6rem; max-width: 100%; border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-sm); background: var(--chronicle-panel-surface); color: var(--chronicle-text); font: inherit; }
button { cursor: pointer; }
[role="alert"] { color: var(--chronicle-danger); }
</style>

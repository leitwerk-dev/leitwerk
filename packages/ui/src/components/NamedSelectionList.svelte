<script lang="ts">
import type { NamedSelection, SettingChoice } from "@leitwerk-dev/protocol/http-contracts";
import { tick } from "svelte";

let {
	rows,
	choices,
	busy,
	id,
	onChange,
}: {
	rows: NamedSelection[];
	choices: readonly SettingChoice[];
	busy: boolean;
	id: string;
	onChange: (rows: NamedSelection[]) => void;
} = $props();
function update(rowId: string, change: Partial<NamedSelection>) {
	onChange(rows.map((row) => (row.id === rowId ? { ...row, ...change } : row)));
}
async function add() {
	const rowId = crypto.randomUUID();
	onChange([...rows, { id: rowId, name: "", values: [] }]);
	await tick();
	document.getElementById(`${id}-${rowId}`)?.focus();
}
async function remove(rowId: string) {
	onChange(rows.filter((row) => row.id !== rowId));
	await tick();
	document.getElementById(`${id}-add`)?.focus();
}
</script>

<div class="named-selections">
	{#each rows as row, index (row.id)}
		<fieldset disabled={busy}>
			<legend>{row.name || `Group ${index + 1}`}</legend>
			<div class="row-heading">
				<label for={`${id}-${row.id}`}>Group name
					<input id={`${id}-${row.id}`} value={row.name} required oninput={(event) => update(row.id, { name: event.currentTarget.value })} />
				</label>
				<button type="button" aria-label={`Remove ${row.name || `group ${index + 1}`}`} onclick={() => remove(row.id)}>Remove group</button>
			</div>
			<p aria-live="polite">{row.values.length} selected</p>
			<div class="options">
				{#each choices as choice (choice.value)}
					<label class="option">
						<input type="checkbox" checked={row.values.includes(choice.value)} disabled={Boolean(choice.disabledReason) && !row.values.includes(choice.value)} onchange={(event) => update(row.id, { values: event.currentTarget.checked ? [...new Set([...row.values, choice.value])] : row.values.filter((value) => value !== choice.value) })} />
						<span>{choice.label}{choice.disabledReason ? ` — ${choice.disabledReason}` : ""}</span>
					</label>
				{/each}
			</div>
		</fieldset>
	{:else}
		<p>No groups. Add a group, name it, then search for its members.</p>
	{/each}
	<button id={`${id}-add`} type="button" disabled={busy} onclick={add}>Add group</button>
</div>

<style>
.named-selections { display: grid; gap: 1.25rem; min-width: 0; }
fieldset { border: 0; border-top: 1px solid var(--chronicle-border); padding: 1rem 0 0; min-width: 0; }
legend { font-weight: 600; overflow-wrap: anywhere; }
.row-heading { display: flex; gap: 1rem; align-items: end; }
.row-heading label { flex: 1; min-width: 0; font-size: var(--type-body-sm); }
input:not([type="checkbox"]) { display: block; width: 100%; margin-top: .4rem; min-height: 44px; border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-sm); padding: .7rem; background: var(--chronicle-panel-surface); color: var(--chronicle-text); font: inherit; }
p { color: var(--chronicle-text-muted); font-size: var(--type-body-sm); }
.options { max-height: 16rem; overflow: auto; }
.option { display: flex; gap: .75rem; align-items: center; min-height: 44px; cursor: pointer; }
.option span { overflow-wrap: anywhere; min-width: 0; }
input[type="checkbox"] { flex: 0 0 auto; accent-color: var(--chronicle-accent); }
button { min-height: 44px; justify-self: start; padding: .5rem .85rem; border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-sm); background: var(--chronicle-panel-surface); color: var(--chronicle-text); font: inherit; cursor: pointer; }
button:hover:not(:disabled), .option:hover { background: var(--chronicle-panel-muted); }
button:disabled { opacity: .6; cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 3px; }
@media (max-width: 600px) { .row-heading { flex-direction: column; align-items: stretch; } }
</style>

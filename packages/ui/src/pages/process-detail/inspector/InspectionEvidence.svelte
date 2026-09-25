<script lang="ts">
import type { InspectionEvidence } from "@leitwerk-dev/domain";
import ChronicleMarkdown from "../../../chronicle/components/ChronicleMarkdown.svelte";

let {
	label,
	evidence,
	markdown = false,
	open = false,
	id = label,
}: {
	label: string;
	evidence: InspectionEvidence<unknown>;
	markdown?: boolean;
	open?: boolean;
	id?: string;
} = $props();
let copyState = $state("Copy");
const value = $derived("value" in evidence ? evidence.value : null);
const text = $derived(typeof value === "string" ? value : JSON.stringify(value, null, 2));
async function copy() {
	try {
		await navigator.clipboard.writeText(text ?? "");
		copyState = "Copied";
	} catch {
		copyState = "Copy failed";
	}
}
</script>
<details class="evidence" data-disclosure-key={id} {open}>
  <summary><span>{label}</span><span class="evidence-state">{evidence.state.replaceAll("_", " ")}</span></summary>
  <div class="evidence-body">
    {#if "value" in evidence}
      {#if evidence.state === "redacted"}<p class="note">Sensitive values were redacted from this recorded evidence.</p>{/if}
      <button type="button" class="ui-button" onclick={copy} aria-label={`Copy ${label}`}>{copyState}</button>
      {#if markdown && typeof value === "string"}<ChronicleMarkdown markdown={value} />{:else}<pre>{text === "" || text === "[]" ? "Empty (recorded)" : text}</pre>{/if}
    {:else}<p class="note">{evidence.reason}</p>{/if}
  </div>
</details>
<style>
.evidence {border:1px solid var(--chronicle-border); border-radius:var(--radius-sm); min-width:0; background:var(--chronicle-card-surface);}
summary {display:flex; justify-content:space-between; gap:var(--space-sm); align-items:baseline; padding:var(--space-sm) var(--space-md); cursor:pointer; font-weight:600; font-size:var(--type-body-sm);}
summary::before {content:"+"; font-size:1rem; flex:none;} .evidence[open] > summary::before {content:"−";}
summary span:first-child {flex:1;} .evidence-state {font-weight:400; color:var(--chronicle-text-muted); font-size:var(--type-caption);}
summary:focus-visible {outline:2px solid var(--chronicle-accent); outline-offset:2px;}
.evidence-body {display:grid; gap:var(--space-sm); padding:0 var(--space-md) var(--space-md);}
button {justify-self:start;} pre {margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font-family:var(--font-mono); font-size:var(--type-caption); line-height:1.65; max-height:36rem; overflow:auto;}
.note {margin:0; font-size:var(--type-body-sm); color:var(--chronicle-text-muted);}
</style>

<script lang="ts">
import ReadonlyJsonValue from "./ReadonlyJsonValue.svelte";

let { value, label }: { value: unknown; label?: string } = $props();
const isObject = (candidate: unknown): candidate is Record<string, unknown> =>
	typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
const scalar = (candidate: unknown) =>
	candidate === null
		? "null"
		: typeof candidate === "string"
			? candidate
			: JSON.stringify(candidate);
</script>

{#if label}<dt>{label}</dt>{/if}
{#if Array.isArray(value)}
	<dd class="json-group"><ol>{#each value as item}<li><ReadonlyJsonValue value={item} /></li>{/each}</ol></dd>
{:else if isObject(value)}
	<dd class="json-group"><dl>{#each Object.entries(value) as [key, item]}<ReadonlyJsonValue value={item} label={key} />{/each}</dl></dd>
{:else}
	<dd class:null-value={value === null}>{scalar(value)}</dd>
{/if}

<style>
	dt { font-weight: 600; margin-top: .5rem; }
	dd { margin: .125rem 0 .25rem; white-space: pre-wrap; overflow-wrap: anywhere; }
	.json-group { border-left: 2px solid var(--border-color, #ddd); padding-left: .75rem; }
	ol { margin: .25rem 0; padding-left: 1.5rem; }
	.null-value { opacity: .65; font-style: italic; }
</style>

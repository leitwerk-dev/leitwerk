<script lang="ts">
import type { ModelProfileOptionSummary } from "@leitwerk-dev/protocol";

let {
	profiles,
	excluded = [],
	selectedId = "",
}: {
	profiles: readonly ModelProfileOptionSummary[];
	excluded?: readonly ModelProfileOptionSummary[];
	selectedId?: string;
} = $props();
const selected = $derived([...profiles, ...excluded].find((profile) => profile.id === selectedId));
const hasIssue = $derived(
	selectedId
		? !selected || !!selected.policyReason || selected.availability !== "available"
		: !profiles.some((profile) => profile.availability === "available" && !profile.policyReason),
);
const unavailable = $derived([
	...excluded,
	...profiles.filter((profile) => profile.availability !== "available"),
]);
</script>

{#if selected}
	<p class="model-note">{selected.description}{selected.default ? " · Default candidate" : ""}{selected.labels?.length ? ` · ${selected.labels.join(", ")}` : ""}</p>
	{#if selected.policyReason || selected.availability !== "available"}
		<p class="model-note" role="status">{selected.id}: {selected.policyReason ?? selected.safeReason ?? selected.availability}</p>
	{/if}
{:else if selectedId}
	<p class="model-note" role="status">Profile '{selectedId}' is no longer configured. Choose another profile or clear the override.</p>
{/if}
{#if hasIssue && unavailable.length}
	<details>
		<summary>Why unavailable?</summary>
		<ul>{#each unavailable as profile (profile.id)}<li><strong>{profile.id}</strong>: {profile.policyReason ?? profile.safeReason ?? profile.availability}</li>{/each}</ul>
	</details>
{/if}

<style>
	.model-note, details { margin: 0; font-size: var(--type-body-sm); color: var(--chronicle-text-muted); overflow-wrap: anywhere; }
	summary { cursor: pointer; }
	summary:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 2px; }
	ul { padding-inline-start: var(--space-lg); }
</style>

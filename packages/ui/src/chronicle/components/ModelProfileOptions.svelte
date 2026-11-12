<script lang="ts">
import {
	compareModelProfileIds,
	type ModelProfileOptionSummary,
	modelCostRank,
} from "@leitwerk-dev/protocol";

let {
	profiles,
	selectedId = "",
}: { profiles: readonly ModelProfileOptionSummary[]; selectedId?: string } = $props();
const headings = ["Free", "Economy", "Standard", "Premium", "Other models"];
const groups = $derived(
	headings
		.map((label, rank) => ({
			label,
			profiles: profiles
				.filter((profile) => modelCostRank(profile.labels) === rank)
				.toSorted((a, b) => compareModelProfileIds(a.id, b.id)),
		}))
		.filter((group) => group.profiles.length),
);
</script>

{#if selectedId && !profiles.some((profile) => profile.id === selectedId)}
	<option value={selectedId} disabled>{selectedId} — deleted or excluded by policy</option>
{/if}
{#each groups as group (group.label)}
	<optgroup label={group.label}>
		{#each group.profiles as profile (profile.id)}
			<option value={profile.id} disabled={profile.availability !== undefined && profile.availability !== "available"}>
				{profile.label}{profile.availability && profile.availability !== "available" ? ` — ${profile.availability}: ${profile.safeReason ?? "Not ready"}` : ""}
			</option>
		{/each}
	</optgroup>
{/each}

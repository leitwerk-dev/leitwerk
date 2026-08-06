<script lang="ts">
import type { ModelProfileOptionSummary } from "@leitwerk-dev/protocol";

interface Props {
	profiles: readonly ModelProfileOptionSummary[];
}

let { profiles }: Props = $props();
</script>

{#each profiles as profile (profile.id)}
	<option
		value={profile.id}
		disabled={profile.availability !== undefined && profile.availability !== "available"}
	>
		{profile.label}{profile.availability && profile.availability !== "available"
			? ` — ${profile.availability}`
			: ""}
	</option>
{/each}

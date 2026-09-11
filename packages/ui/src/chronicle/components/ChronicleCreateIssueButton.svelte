<script lang="ts">
import type { ChronicleTicketArtifact } from "../lib/chronicle-ticket-artifact.js";

interface Props {
	artifact: ChronicleTicketArtifact;
	onDraftTicket: (artifact: ChronicleTicketArtifact) => void;
}

let { artifact, onDraftTicket }: Props = $props();
</script>

<button
	type="button"
	class="ui-button create-issue-button"
	data-pressable="true"
	onclick={() => onDraftTicket(artifact)}
>Create issue</button>

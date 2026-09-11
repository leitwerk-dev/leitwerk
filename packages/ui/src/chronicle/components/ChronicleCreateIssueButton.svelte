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

<style>
	.create-issue-button { min-height: 28px; padding: 3px 0; border: 0; border-radius: 4px; background: transparent; color: var(--chronicle-text-muted); font-size: var(--type-caption); font-weight: 500; box-shadow: none; }
	.create-issue-button:hover { background: transparent; color: var(--chronicle-accent); text-decoration: underline; text-underline-offset: 3px; }
</style>

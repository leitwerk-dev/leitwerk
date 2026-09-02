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
	class="create-issue-button"
	data-pressable="true"
	onclick={() => onDraftTicket(artifact)}
>Create issue</button>

<style>
	.create-issue-button {
		flex: 0 0 auto;
		min-height: 36px;
		padding: 0 13px;
		border: 1px solid var(--chronicle-border-strong);
		border-radius: 999px;
		background: var(--chronicle-card-surface);
		color: var(--chronicle-text);
		font: inherit;
		font-size: var(--type-caption);
		font-weight: 700;
		cursor: pointer;
	}

	.create-issue-button:hover {
		border-color: var(--chronicle-accent);
		background: color-mix(in srgb, var(--chronicle-card-surface) 94%, var(--chronicle-accent) 6%);
		transform: translateY(-1px);
	}

	.create-issue-button:focus-visible {
		outline: 2px solid var(--chronicle-accent);
		outline-offset: 2px;
	}
</style>

<script lang="ts">
import { splitChronicleLines } from "../lib/formatting.js";

interface Props {
	text: string;
	trim?: boolean;
	variant?: "default" | "preview";
}

let { text, trim = false, variant = "default" }: Props = $props();

const lines = $derived(splitChronicleLines(text, { trim }));
</script>

<p class="thinking-copy" data-variant={variant}>
	{#each lines as line, index (`thinking-line-${index}`)}
		<span class="thinking-line">{line.length > 0 ? line : "\u00a0"}</span>
	{/each}
</p>

<style>
	.thinking-copy {
		margin: 0;
		font-family: inherit;
		font-size: var(--type-body-sm);
		line-height: 1.72;
	}

	.thinking-copy[data-variant="default"] {
		max-width: 64ch;
		color: color-mix(in srgb, var(--chronicle-text-muted) 78%, var(--chronicle-text) 22%);
	}

	.thinking-copy[data-variant="preview"] {
		display: grid;
		gap: 0;
		line-height: inherit;
		max-width: 64ch;
		color: color-mix(in srgb, var(--chronicle-text-muted) 82%, var(--chronicle-text) 18%);
	}

	.thinking-line {
		display: block;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>

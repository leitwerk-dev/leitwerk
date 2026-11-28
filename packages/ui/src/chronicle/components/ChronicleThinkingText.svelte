<script lang="ts">
import { normalizeChronicleLineEndings, normalizeChronicleText } from "../lib/formatting.js";

interface Props {
	text: string;
	trim?: boolean;
	variant?: "default" | "preview";
}

let { text, trim = false, variant = "default" }: Props = $props();

const normalizedText = $derived(
	trim ? normalizeChronicleText(text) : normalizeChronicleLineEndings(text),
);
</script>

<p class="thinking-copy" data-variant={variant}>{normalizedText}</p>

<style>
	.thinking-copy {
		margin: 0;
		font-family: inherit;
		font-size: var(--type-body-sm);
		line-height: 1.72;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.thinking-copy[data-variant="default"] {
		max-width: 64ch;
		color: color-mix(in srgb, var(--chronicle-text-muted) 78%, var(--chronicle-text) 22%);
	}

	.thinking-copy[data-variant="preview"] {
		line-height: inherit;
		max-width: 64ch;
		color: color-mix(in srgb, var(--chronicle-text-muted) 82%, var(--chronicle-text) 18%);
	}
</style>

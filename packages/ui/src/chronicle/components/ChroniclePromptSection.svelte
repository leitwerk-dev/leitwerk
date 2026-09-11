<script lang="ts">
import type { ChroniclePromptItem } from "../lib/chronicle-projection.js";
import ChronicleEntryHeader from "./ChronicleEntryHeader.svelte";
import ChronicleMarkdown from "./ChronicleMarkdown.svelte";

interface Props {
	prompt: ChroniclePromptItem;
	isFocused: boolean;
}

let { prompt, isFocused }: Props = $props();
</script>

<section
	id={prompt.anchorId}
	class="prompt-section"
	class:is-focused={isFocused}
	data-anchor-id={prompt.anchorId}
	data-focused={isFocused ? "true" : "false"}
	data-section="chronicle-prompt"
>
	<ChronicleEntryHeader title="Initial prompt" kind="prompt" timestamp={prompt.createdAt} />
	<ChronicleMarkdown
		markdown={prompt.text && prompt.text.trim() !== "" ? prompt.text : "No prompt recorded."}
		className="prompt-markdown"
	/>
</section>

<style>
	.prompt-section { display: grid; gap: 6px; padding: 10px 14px; border: 1px solid var(--chronicle-border); border-radius: 10px; background: var(--chronicle-card-surface-strong); scroll-margin-top: var(--space-sm); }
	.prompt-section.is-focused { border-color: color-mix(in srgb, var(--chronicle-accent) 40%, var(--chronicle-border)); }
	.prompt-section :global(.chronicle-markdown) { padding-inline-start: 42px; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); }
	@media (max-width: 540px) { .prompt-section { padding: 10px; } .prompt-section :global(.chronicle-markdown) { padding-inline-start: 32px; } }
</style>

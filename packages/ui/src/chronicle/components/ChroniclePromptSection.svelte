<script lang="ts">
import { formatRelativeTime } from "../../lib/format";
import type { ChroniclePromptItem } from "../lib/chronicle-projection.js";
import ChronicleMarkdown from "./ChronicleMarkdown.svelte";
import ChronicleSectionHeader from "./ChronicleSectionHeader.svelte";

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
	<ChronicleSectionHeader
		label="Prompt"
		meta={prompt.createdAt ? formatRelativeTime(prompt.createdAt) : null}
	/>
	<ChronicleMarkdown
		markdown={prompt.text && prompt.text.trim() !== "" ? prompt.text : "No prompt recorded."}
		className="prompt-markdown"
	/>
</section>

<style>
	.prompt-section {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 14px 0 16px;
		margin-inline-start: var(--chronicle-secondary-indent, clamp(24px, 4vw, 48px));
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 82%, white 18%);
		background: transparent;
		scroll-margin-top: var(--space-lg);
	}

	.prompt-section.is-focused {
		border-top-color: color-mix(in srgb, var(--chronicle-accent) 50%, var(--chronicle-border) 50%);
	}

	@media (max-width: 720px) {
		.prompt-section {
			margin-inline-start: 0;
		}
	}
</style>

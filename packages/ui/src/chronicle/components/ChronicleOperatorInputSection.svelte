<script lang="ts">
import type { ChronicleOperatorInputItem } from "../lib/chronicle-projection.js";
import ChronicleEntryHeader from "./ChronicleEntryHeader.svelte";
import ChronicleMarkdown from "./ChronicleMarkdown.svelte";

interface Props {
	section: ChronicleOperatorInputItem;
}

let { section }: Props = $props();
</script>

<section
	class="operator-input"
	data-section="operator-input"
	data-input-id={section.inputId}
	data-input-source={section.source}
>
	<ChronicleEntryHeader title={section.sourceLabel} kind="operator" timestamp={section.receivedAt} />

	<ChronicleMarkdown markdown={section.bodyMarkdown} className="operator-input-markdown" />
</section>

<style>
	.operator-input { display: grid; gap: 6px; padding: 10px 14px; border: 1px solid var(--chronicle-border); border-radius: 10px; background: var(--chronicle-card-surface-strong); scroll-margin-top: var(--space-sm); }
	.operator-input :global(.chronicle-markdown) { padding-inline-start: 42px; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); }
	@media (max-width: 540px) { .operator-input { padding: 10px; } .operator-input :global(.chronicle-markdown) { padding-inline-start: 32px; } }
</style>

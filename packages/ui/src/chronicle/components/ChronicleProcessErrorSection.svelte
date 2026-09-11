<script lang="ts">
import ChronicleEntryHeader from "./ChronicleEntryHeader.svelte";
import ChronicleFailureMessage from "./ChronicleFailureMessage.svelte";

interface Props {
	anchorId: string;
	isFocused: boolean;
	title: string;
	summary: string;
	guidance?: string;
	technicalDetail?: string | null;
}

let {
	anchorId,
	isFocused,
	title,
	summary,
	guidance = "This process stopped before it produced a recoverable failed turn. Inspect the latest state, then retry or restart it when you are ready.",
	technicalDetail = null,
}: Props = $props();
</script>

<section id={anchorId} class="process-error-section" class:is-focused={isFocused} data-anchor-id={anchorId} data-focused={isFocused ? "true" : "false"} data-section="current-process-error" tabindex="-1">
 <ChronicleEntryHeader {title} kind="system" failed />
 <ChronicleFailureMessage {summary} {technicalDetail} />
 <p class="process-error-guidance">{guidance}</p>
</section>

<style>
 .process-error-section { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 14px; border: 1px solid color-mix(in srgb, var(--chronicle-danger) 50%, var(--chronicle-border)); border-radius: 10px; background: color-mix(in srgb, var(--chronicle-danger) 2%, var(--chronicle-card-surface)); scroll-margin-top: 28px; }
 .process-error-guidance { margin: 0; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); line-height: 1.55; }
 @media (max-width: 540px) { .process-error-section { padding: 10px; } }
</style>

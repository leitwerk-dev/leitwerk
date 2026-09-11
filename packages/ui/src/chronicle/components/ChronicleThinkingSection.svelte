<script lang="ts">
import type { ProcessQuestionRequest } from "@leitwerk-dev/domain";
import { THINKING_PREVIEW_LINE_COUNT } from "../lib/chronicle-projection.js";
import { splitChronicleLines } from "../lib/formatting.js";
import ChronicleQuestionRequest from "./ChronicleQuestionRequest.svelte";
import ChronicleThinkingText from "./ChronicleThinkingText.svelte";

interface Props {
	text: string;
	preview: string;
	previewTruncated?: boolean;
	traceItemCount: number;
	isLive?: boolean;
	questionRequests?: readonly ProcessQuestionRequest[];
}
let {
	text,
	preview,
	previewTruncated = false,
	traceItemCount,
	isLive = false,
	questionRequests = [],
}: Props = $props();
const previewLines = $derived(
	splitChronicleLines(preview || text).filter((line) => line.trim() !== ""),
);
</script>

{#if (isLive && previewLines.length > 0) || questionRequests.length > 0}
	<section class="thinking-section" class:is-live={isLive} data-section="thinking-preview" data-live={isLive ? "true" : "false"}>
		{#if isLive && previewLines.length > 0}
			<span class="reasoning-label">Reasoning</span>
			<div class="thinking-preview-copy" data-line-count={previewLines.length} data-truncated={previewTruncated ? "true" : "false"} data-trace-item-count={traceItemCount} style:--thinking-preview-lines={THINKING_PREVIEW_LINE_COUNT}>
				<ChronicleThinkingText text={previewLines.join("\n")} variant="preview" />
			</div>
		{/if}
		{#if questionRequests.length > 0}
			<div class="reasoning-questions" data-section="reasoning-questions">
				{#each questionRequests as request (request.id)}<ChronicleQuestionRequest {request} />{/each}
			</div>
		{/if}
	</section>
{/if}

<style>
	.thinking-section { display: grid; gap: 8px; min-width: 0; }
	.reasoning-label { color: var(--chronicle-text-muted); font-size: var(--type-body-sm); font-weight: 600; }
	.thinking-preview-copy { display: flex; flex-direction: column; justify-content: flex-end; max-height: calc(var(--thinking-preview-lines, 4) * 1lh); max-width: 72ch; overflow: clip; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); line-height: 1.6; }
	.thinking-preview-copy > :global(*) { flex: 0 0 auto; }
	.reasoning-questions { display: grid; gap: var(--space-sm); }
</style>

<script lang="ts">
import { THINKING_PREVIEW_LINE_COUNT } from "../lib/chronicle-projection.js";
import { normalizeChronicleText, splitChronicleLines } from "../lib/formatting.js";
import ChronicleExpandButton from "./ChronicleExpandButton.svelte";
import ChronicleLiveChip from "./ChronicleLiveChip.svelte";
import ChronicleThinkingText from "./ChronicleThinkingText.svelte";

interface Props {
	text: string;
	preview: string;
	previewTruncated?: boolean;
	toolCallCount: number;
	traceItemCount: number;
	isLive?: boolean;
	onOpenDetails?: (() => void) | null;
}

let {
	text,
	preview,
	previewTruncated = false,
	toolCallCount,
	traceItemCount,
	isLive = false,
	onOpenDetails = null,
}: Props = $props();

const previewLines = $derived(splitChronicleLines(preview));
const fallbackLines = $derived(splitChronicleLines(text));
const hasPreview = $derived(previewLines.length > 0);
const hasText = $derived(normalizeChronicleText(text).length > 0);
const hasDetails = $derived(Boolean(onOpenDetails));
const showsReasoningText = $derived(hasPreview || (traceItemCount === 0 && hasText));
const isCompactReasoning = $derived(!showsReasoningText && !isLive);
const overflowAffordanceCopy = $derived(
	hasDetails
		? "Earlier reasoning hidden · open details for the full trace"
		: "Earlier reasoning hidden",
);
</script>

<section
	class="thinking-section"
	class:is-live={isLive}
	data-section="thinking-preview"
	data-live={isLive ? "true" : "false"}
>
	<div class="reasoning-header">
		<div class="reasoning-heading">
			<p class="reasoning-label">Reasoning</p>
			{#if isLive}
				<ChronicleLiveChip label="Live" size="sm" />
			{/if}
		</div>
		{#if hasDetails}
			<ChronicleExpandButton
				expanded={false}
				collapsedLabel="Expand reasoning"
				class="details-button"
				dataAction="open-reasoning-details"
				ariaLabel="Expand reasoning"
				onClick={() => onOpenDetails?.()}
			/>
		{/if}
	</div>

	<div
		class="thinking-preview-copy"
		data-line-count={previewLines.length > 0 ? previewLines.length : fallbackLines.length}
		data-truncated={previewTruncated ? "true" : "false"}
		data-trace-item-count={traceItemCount}
		data-compact={isCompactReasoning ? "true" : undefined}
		style:--thinking-preview-lines={THINKING_PREVIEW_LINE_COUNT}
	>
		{#if hasPreview}
			<ChronicleThinkingText text={preview} variant="preview" />
		{:else if toolCallCount > 0 || traceItemCount > 0}
			<p class="empty-copy">Open details to inspect the reasoning trace.</p>
		{:else if hasText}
			<ChronicleThinkingText text={text} variant="preview" />
		{:else}
			<p class="empty-copy">No reasoning was recorded.</p>
		{/if}

		<div
			class="overflow-affordance"
			data-visible={previewTruncated ? "true" : "false"}
			aria-hidden={previewTruncated ? undefined : true}
		>
			{previewTruncated ? overflowAffordanceCopy : "\u00a0"}
		</div>
	</div>
</section>

<style>
	.thinking-section {
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		gap: 12px;
		padding: 12px 14px;
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 82%, white 18%);
		background: color-mix(in srgb, var(--chronicle-panel-muted) 76%, white 24%);
		overflow: hidden;
	}

	.reasoning-header,
	.reasoning-heading {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		min-width: 0;
	}

	.reasoning-header {
		justify-content: space-between;
	}

	.reasoning-heading {
		flex-wrap: wrap;
	}

	.reasoning-label {
		margin: 0;
		font-size: var(--type-label);
		font-weight: 700;
		letter-spacing: var(--tracking-label);
		line-height: 1.4;
		text-transform: uppercase;
		color: var(--chronicle-text-muted);
	}

	.thinking-preview-copy {
		--thinking-preview-body-height: calc(var(--thinking-preview-lines, 3) * 1lh);
		display: grid;
		grid-template-rows: var(--thinking-preview-body-height) 1lh;
		gap: 8px;
		width: min(100%, 64ch);
		min-width: 0;
		align-items: start;
		font-size: var(--type-body-sm);
		line-height: 1.72;
	}

	.thinking-preview-copy :global(.thinking-copy[data-variant="preview"]),
	.thinking-preview-copy .empty-copy {
		min-height: 0;
		max-height: var(--thinking-preview-body-height);
		overflow: hidden;
	}

	.thinking-preview-copy[data-compact="true"] {
		grid-template-rows: auto;
	}

	.thinking-preview-copy[data-compact="true"] .empty-copy {
		max-height: none;
	}

	.thinking-preview-copy[data-compact="true"] .overflow-affordance {
		display: none;
	}

	.overflow-affordance {
		min-height: 1lh;
		font-size: 11px;
		font-weight: 620;
		letter-spacing: 0.01em;
		color: color-mix(in srgb, var(--chronicle-text-muted) 86%, var(--chronicle-text) 14%);
	}

	.overflow-affordance[data-visible="false"] {
		visibility: hidden;
	}

	.empty-copy {
		margin: 0;
		max-width: none;
		font-family: inherit;
		font-size: var(--type-body-sm);
		line-height: 1.72;
		color: var(--chronicle-text-muted);
	}

	@media (max-width: 720px) {
		.reasoning-header {
			align-items: flex-start;
			flex-direction: column;
		}
	}
</style>

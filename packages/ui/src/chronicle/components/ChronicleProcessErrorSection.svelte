<script lang="ts">
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

<section
	id={anchorId}
	class="process-error-section chronicle-danger-panel"
	class:is-focused={isFocused}
	data-anchor-id={anchorId}
	data-focused={isFocused ? "true" : "false"}
	data-section="current-process-error"
	tabindex="-1"
>
	<div class="process-error-copy">
		<p class="process-error-eyebrow chronicle-danger-eyebrow">Process issue</p>
		<h3>{title}</h3>
		<p class="process-error-summary">{summary}</p>
		<p class="process-error-guidance">{guidance}</p>
	</div>
	{#if technicalDetail}
		<details class="process-error-detail chronicle-danger-detail">
			<summary>Technical details</summary>
			<pre>{technicalDetail}</pre>
		</details>
	{/if}
</section>

<style>
	:global(.chronicle-danger-panel) {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 20px 22px;
		border: 1px solid color-mix(in srgb, var(--chronicle-danger) 34%, var(--chronicle-border) 66%);
		border-radius: 20px;
		background: color-mix(in srgb, var(--chronicle-danger) 6%, var(--chronicle-card-surface));
		scroll-margin-top: 28px;
	}

	:global(.chronicle-danger-panel.is-focused) {
		border-color: color-mix(in srgb, var(--chronicle-danger) 50%, var(--chronicle-border) 50%);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--chronicle-danger) 22%, transparent 78%);
	}

	:global(.chronicle-danger-eyebrow) {
		margin: 0;
		font-size: var(--type-label);
		font-weight: 700;
		letter-spacing: var(--tracking-label);
		text-transform: uppercase;
		color: color-mix(in srgb, var(--chronicle-danger-text) 84%, var(--chronicle-text) 16%);
	}

	:global(.chronicle-danger-detail > pre) {
		margin: 8px 0 0;
		padding: 10px 12px;
		border-radius: 10px;
		background: color-mix(in srgb, var(--chronicle-danger) 4%, var(--chronicle-panel-muted) 96%);
		color: var(--chronicle-text);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 12px;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		overflow-x: auto;
	}

	.process-error-copy {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.process-error-copy h3,
	.process-error-summary,
	.process-error-guidance {
		margin: 0;
	}

	.process-error-copy h3 {
		font-size: var(--type-heading-sm);
		line-height: 1.2;
		color: var(--chronicle-text);
	}

	.process-error-summary {
		font-size: 14px;
		line-height: 1.5;
		color: var(--chronicle-text);
	}

	.process-error-guidance {
		font-size: 13px;
		line-height: 1.5;
		color: var(--chronicle-text-muted);
	}

	.process-error-detail {
		font-size: 12px;
		color: var(--chronicle-text-muted);
	}

	.process-error-detail > summary {
		cursor: pointer;
		font-weight: 600;
		color: color-mix(in srgb, var(--chronicle-text-muted) 88%, var(--chronicle-text) 12%);
		user-select: none;
	}

	.process-error-detail > summary:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--chronicle-danger) 60%, transparent);
		outline-offset: 2px;
		border-radius: 4px;
	}
</style>

<script lang="ts">
let {
	summary,
	recordedAt,
	onDismiss,
}: {
	summary: string;
	recordedAt?: string;
	onDismiss: () => void;
} = $props();
</script>

<div class="process-summary" data-section="process-summary">
	<div class="summary-copy">
		<p>{summary}</p>
		{#if recordedAt}<time datetime={recordedAt}>Updated {new Date(recordedAt).toLocaleString()}</time>{/if}
	</div>
	<button type="button" class="dismiss-summary" aria-label="Dismiss process summary" title="Hide for this process in this browser" onclick={onDismiss}>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
	</button>
</div>

<style>
	.process-summary { display: flex; align-items: flex-start; gap: var(--space-xs); flex-shrink: 0; min-width: 0; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); line-height: 1.5; }
	.summary-copy { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--space-sm); flex: 1; min-width: 0; padding-block: 5px; }
	p { margin: 0; overflow-wrap: anywhere; }
	time { font-size: var(--type-caption); }
	.dismiss-summary { display: grid; place-items: center; flex-shrink: 0; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; color: inherit; cursor: pointer; }
	.dismiss-summary:hover { color: var(--chronicle-text); }
	.dismiss-summary:hover { background: var(--chronicle-panel-muted); }
	.dismiss-summary:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 2px; }
	@media (max-width: 540px) {
		.dismiss-summary { width: 44px; height: 44px; }
	}
</style>

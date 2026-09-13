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
	<details>
		<summary aria-label={`Process summary: ${summary}`}>
			<span class="summary-text">{summary}</span>
			<svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
		</summary>
		{#if recordedAt}<time datetime={recordedAt}>Updated {new Date(recordedAt).toLocaleString()}</time>{/if}
	</details>
	<button type="button" class="dismiss-summary" aria-label="Dismiss process summary" title="Hide for this process in this browser" onclick={onDismiss}>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
	</button>
</div>

<style>
	.process-summary { display: flex; align-items: flex-start; gap: var(--space-xs); flex-shrink: 0; min-width: 0; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); line-height: 1.5; }
	details { flex: 1; min-width: 0; }
	summary { display: flex; align-items: center; gap: var(--space-xs); min-height: 32px; cursor: pointer; list-style: none; }
	summary::-webkit-details-marker { display: none; }
	.summary-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.chevron { flex-shrink: 0; }
	details[open] .summary-text { white-space: normal; overflow-wrap: anywhere; }
	details[open] .chevron { transform: rotate(180deg); }
	time { display: block; margin-top: var(--space-2xs); font-size: var(--type-caption); }
	.dismiss-summary { display: grid; place-items: center; flex-shrink: 0; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; color: inherit; cursor: pointer; }
	summary:hover, .dismiss-summary:hover { color: var(--chronicle-text); }
	.dismiss-summary:hover { background: var(--chronicle-panel-muted); }
	summary:focus-visible, .dismiss-summary:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 2px; }
	@media (max-width: 540px) {
		summary { min-height: 44px; }
		.dismiss-summary { width: 44px; height: 44px; }
	}
</style>

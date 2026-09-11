<script lang="ts">
let { summary, technicalDetail = null }: { summary: string; technicalDetail?: string | null } =
	$props();

const heartbeat = $derived(
	/worker heartbeat stale for \S+ after (\d+)ms/i.exec(technicalDetail || summary),
);
const message = $derived(
	heartbeat
		? `Worker stopped responding. No heartbeat was received for ${Number(heartbeat[1]) / 1000} seconds.`
		: summary,
);
const detail = $derived(technicalDetail || (heartbeat ? summary : null));
</script>

<div class="failure-message" data-section="failure-message">
	<svg class="failure-icon" width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="15" cy="15" r="13" /><path d="m11 11 8 8m0-8-8 8" /></svg>
	<div class="failure-copy">
		<h4>Failed</h4>
		<p>{message}</p>
		{#if detail}
			<details class="failure-detail">
				<summary>Technical details</summary>
				<pre>{detail}</pre>
			</details>
		{/if}
	</div>
</div>

<style>
	.failure-message { display: grid; grid-template-columns: 30px minmax(0, 1fr); align-items: start; gap: 12px; padding: 14px; border: 1px solid color-mix(in srgb, var(--chronicle-danger) 20%, var(--chronicle-border)); border-radius: 8px; background: color-mix(in srgb, var(--chronicle-danger) 4%, var(--chronicle-card-surface)); }
	.failure-icon { color: var(--chronicle-danger); }
	.failure-copy { min-width: 0; }
	h4 { margin: 0 0 4px; color: var(--chronicle-danger-text); font-size: var(--type-body-lg); line-height: 1.4; font-weight: 650; }
	p { margin: 0; color: var(--chronicle-text); font-size: var(--type-body-sm); line-height: 1.6; overflow-wrap: anywhere; }
	.failure-detail { margin-top: 12px; color: var(--chronicle-text-muted); font-size: var(--type-caption); }
	summary { width: fit-content; cursor: pointer; font-weight: 600; }
	summary:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 3px; border-radius: 3px; }
	pre { margin: 8px 0 0; padding: 10px; border-radius: 5px; background: var(--chronicle-panel-muted); color: var(--chronicle-text); font-family: var(--font-mono, monospace); font-size: var(--type-caption); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
	@media (max-width: 540px) { .failure-message { grid-template-columns: 24px minmax(0, 1fr); padding: 10px; gap: 8px; } .failure-icon { width: 24px; height: 24px; } }
</style>

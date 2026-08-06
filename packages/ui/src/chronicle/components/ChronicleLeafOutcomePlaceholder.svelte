<script lang="ts">
interface Props {
	latestTurnTitle: string | null;
}

let { latestTurnTitle }: Props = $props();
</script>

<div class="placeholder-block" data-section="leaf-outcome-placeholder">
	<p>No result preview is available yet.</p>
	{#if latestTurnTitle}
		<p class="placeholder-note">Latest completed step: {latestTurnTitle}.</p>
	{/if}
</div>

<style>
	.placeholder-block {
		padding: 16px 18px;
		margin-inline-start: var(--chronicle-secondary-indent, clamp(24px, 4vw, 48px));
		border-radius: 16px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 82%, white 18%);
		background: color-mix(in srgb, var(--chronicle-panel-muted) 68%, white 32%);
		color: var(--chronicle-text-muted);
	}

	.placeholder-block p {
		margin: 0;
		max-width: 72ch;
		font-size: var(--type-body);
		line-height: 1.6;
	}

	.placeholder-note {
		margin-top: 8px;
		font-weight: 600;
		color: var(--chronicle-text);
	}

	@media (max-width: 720px) {
		.placeholder-block {
			margin-inline-start: 0;
		}
	}
</style>

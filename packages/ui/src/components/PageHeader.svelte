<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	title: string;
	titleId?: string;
	subtitle?: string | null;
	actions?: Snippet;
	titleSuffix?: Snippet;
	compactOnMobile?: boolean;
}

let {
	title,
	titleId = undefined,
	subtitle = null,
	actions,
	titleSuffix,
	compactOnMobile = false,
}: Props = $props();
</script>

<header
	class="page-header"
	data-section="page-header"
	data-mobile-layout={compactOnMobile ? "compact" : undefined}
>
	<div class="page-header-row">
		<div class="page-header-copy">
			<h1 id={titleId}>
				<span>{title}</span>
				{#if titleSuffix}
					{@render titleSuffix()}
				{/if}
			</h1>
		</div>
		{#if actions}
			<div class="page-header-actions">
				{@render actions()}
			</div>
		{/if}
	</div>
	{#if subtitle}
		<p class="page-header-subtitle">{subtitle}</p>
	{/if}
</header>

<style>
	.page-header {
		position: relative;
		display: grid;
		gap: var(--space-sm);
		z-index: 5;
	}

	.page-header-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		min-width: 0;
		min-height: 44px;
		padding: 0 0 var(--space-sm);
		border-bottom: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
	}

	.page-header-copy {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.page-header-subtitle {
		margin: 0;
	}

	h1 {
		margin: 0;
		min-width: 0;
		max-width: min(100%, 68ch);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-display);
		font-size: clamp(1.12rem, 1rem + 0.45vw, 1.42rem);
		line-height: 1.08;
		font-weight: 650;
		letter-spacing: -0.012em;
		color: var(--chronicle-text);
	}

	.page-header-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-xs);
		min-width: 0;
		flex: 0 0 auto;
		flex-wrap: wrap;
	}

	.page-header-actions :global(.page-header-button) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		flex-shrink: 0;
		min-height: 31px;
		padding: 0 var(--space-sm);
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 82%, white 18%);
		border-radius: 999px;
		background: color-mix(in srgb, white 92%, var(--chronicle-panel-muted) 8%);
		color: var(--chronicle-text);
		font: inherit;
		font-size: var(--type-body-sm);
		font-weight: 620;
		line-height: 1;
		cursor: pointer;
	}

	.page-header-actions :global(.page-header-button:hover:not(:disabled)),
	.page-header-actions :global(.page-header-button:focus-visible) {
		transform: translateY(-1px);
		border-color: color-mix(in srgb, var(--chronicle-accent) 24%, var(--chronicle-border-strong) 76%);
		outline: none;
	}

	.page-header-actions :global(.page-header-button:disabled) {
		cursor: default;
		opacity: 0.6;
		transform: none;
	}

	.page-header-subtitle {
		max-width: 68ch;
		font-size: var(--type-body-sm);
		line-height: 1.55;
		color: var(--chronicle-text-muted);
	}

	@media (max-width: 720px) {
		.page-header-row,
		.page-header-actions {
			align-items: stretch;
			flex-direction: column;
		}

		.page-header-actions {
			width: 100%;
		}

		h1 {
			font-size: 1.02rem;
			line-height: 1.16;
			white-space: normal;
		}

		.page-header[data-mobile-layout="compact"] .page-header-row,
		.page-header[data-mobile-layout="compact"] .page-header-actions {
			flex-direction: row;
			align-items: center;
		}

		.page-header[data-mobile-layout="compact"] .page-header-actions {
			width: auto;
			flex: 0 0 auto;
		}

		.page-header[data-mobile-layout="compact"] h1 {
			white-space: nowrap;
		}
	}
</style>

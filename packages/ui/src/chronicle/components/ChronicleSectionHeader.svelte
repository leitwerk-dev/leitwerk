<script lang="ts">
import type { Snippet } from "svelte";

type SectionHeaderTone = "neutral" | "accent" | "danger";
type SectionHeadingLevel = 2 | 3 | 4 | 5 | 6;

interface Props {
	label: string;
	secondary?: string | null;
	meta?: string | null;
	tone?: SectionHeaderTone;
	headingLevel?: SectionHeadingLevel | null;
	children?: Snippet;
}

let {
	label,
	secondary = null,
	meta = null,
	tone = "accent",
	headingLevel = null,
	children,
}: Props = $props();

const headingTag = $derived(headingLevel ? (`h${headingLevel}` as const) : null);
</script>

<div class="chronicle-section-header" data-tone={tone}>
	<div class="section-label-row">
		{#if headingTag}
			<svelte:element this={headingTag} class="section-label">{label}</svelte:element>
		{:else}
			<p class="section-label">{label}</p>
		{/if}
		{#if secondary}
			<span class="section-separator" aria-hidden="true"></span>
			<span class="section-secondary">{secondary}</span>
		{/if}
	</div>

	{#if children}
		<div class="section-side">
			{@render children()}
		</div>
	{:else if meta}
		<span class="section-meta">{meta}</span>
	{/if}
</div>

<style>
	.chronicle-section-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-md);
		min-width: 0;
	}

	.section-label-row {
		display: flex;
		align-items: baseline;
		gap: var(--space-xs);
		min-width: 0;
		color: var(--chronicle-text-faint);
	}

	.chronicle-section-header[data-tone="accent"] .section-label {
		color: var(--chronicle-accent);
	}

	.chronicle-section-header[data-tone="danger"] .section-label {
		color: color-mix(in srgb, var(--chronicle-danger-text) 84%, var(--chronicle-text) 16%);
	}

	.section-label {
		margin: 0;
		font-size: var(--type-label);
		font-weight: 700;
		letter-spacing: var(--tracking-label);
		line-height: 1.4;
		text-transform: uppercase;
		color: inherit;
	}

	.section-separator {
		align-self: center;
		width: 1px;
		height: 12px;
		border-radius: 999px;
		background: currentColor;
		opacity: 0.36;
	}

	.section-secondary,
	.section-meta {
		font-size: var(--type-caption);
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		line-height: 1.4;
		white-space: nowrap;
	}

	.section-secondary {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		color: inherit;
	}

	.section-meta {
		flex-shrink: 0;
		color: var(--chronicle-text-muted);
	}

	.section-side {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-xs);
		min-width: 0;
	}

	@media (max-width: 720px) {
		.chronicle-section-header {
			align-items: flex-start;
			flex-direction: column;
			gap: var(--space-xs);
		}

		.section-meta,
		.section-side {
			white-space: normal;
		}
	}
</style>

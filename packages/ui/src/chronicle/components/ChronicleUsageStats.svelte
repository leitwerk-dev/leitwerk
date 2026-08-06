<script lang="ts">
import type { TurnUsageSnapshot } from "@leitwerk-dev/protocol";
import { formatUsageSummaryTitle, formatUsdEstimate } from "../../lib/cost-estimates.js";
import { formatCompactTokenCount } from "../lib/formatting.js";

interface Props {
	usage: TurnUsageSnapshot;
	size?: "sm" | "md";
	showCacheIcons?: boolean;
}

let { usage, size = "sm", showCacheIcons = true }: Props = $props();

const title = $derived(formatUsageSummaryTitle(usage));
</script>

<span class="usage-stats" data-size={size} title={title}>
	{#if usage.cost}
		<span class="usage-item cost-estimate">Est. {formatUsdEstimate(usage.cost.total)}</span>
	{/if}
	<span class="usage-item">
		<span class="usage-figure">↑{formatCompactTokenCount(usage.input)}</span>
		<span class="usage-label">in</span>
	</span>
	<span class="usage-item">
		<span class="usage-figure">↓{formatCompactTokenCount(usage.output)}</span>
		<span class="usage-label">out</span>
	</span>
	{#if usage.reasoning !== undefined}
		<span class="usage-item reasoning">
			<span class="usage-figure">{formatCompactTokenCount(usage.reasoning)}</span>
			<span class="usage-label">reason</span>
		</span>
	{/if}
	{#if usage.cacheRead > 0}
		<span class="usage-item cache-read">
			<span class="usage-figure">{showCacheIcons ? "⚡" : ""}{formatCompactTokenCount(usage.cacheRead)}</span>
			<span class="usage-label">cached</span>
		</span>
	{/if}
	{#if usage.cacheWrite > 0}
		<span class="usage-item cache-write">
			<span class="usage-figure">{showCacheIcons ? "💾" : ""}{formatCompactTokenCount(usage.cacheWrite)}</span>
			<span class="usage-label">written</span>
		</span>
	{/if}
	{#if usage.requestCount !== undefined}
		<span class="usage-item request-count">
			<span class="usage-figure">{usage.requestCount}</span>
			<span class="usage-label">req</span>
		</span>
	{/if}
	{#if usage.maxInputTokens !== undefined}
		<span class="usage-item max-input">
			<span class="usage-figure">↑{formatCompactTokenCount(usage.maxInputTokens)}</span>
			<span class="usage-label">peak in</span>
		</span>
	{/if}
</span>

<style>
	.usage-stats {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		font-variant-numeric: tabular-nums;
		color: var(--chronicle-text-faint);
	}

	.usage-stats[data-size="sm"] {
		gap: 6px;
		font-size: 11px;
	}

	.usage-stats[data-size="md"] {
		gap: 8px;
		font-size: 12px;
	}

	.usage-item {
		display: inline-flex;
		align-items: baseline;
		gap: 3px;
	}

	.usage-figure {
		font-variant-numeric: tabular-nums;
	}

	.usage-label {
		font-size: 0.85em;
		color: color-mix(in srgb, currentColor 62%, transparent 38%);
	}

	.usage-item.cost-estimate {
		font-weight: inherit;
		color: inherit;
	}

	.usage-item.cache-read,
	.usage-item.cache-write,
	.usage-item.reasoning,
	.usage-item.request-count,
	.usage-item.max-input {
		color: inherit;
	}
</style>

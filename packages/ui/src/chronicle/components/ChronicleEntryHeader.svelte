<script lang="ts">
import Icon from "@leitwerk-dev/workflow-graph/internal/WorkflowIcon.svelte";
import type { Snippet } from "svelte";
import { formatRelativeTime } from "../../lib/format.js";

interface Props {
	title: string;
	kind?: "llm" | "system" | "operator" | "external" | "prompt" | "result";
	metadata?: string | null;
	timestamp?: string | null;
	duration?: string | null;
	failed?: boolean;
	controls?: Snippet;
}

let {
	title,
	kind = "system",
	metadata,
	timestamp,
	duration,
	failed = false,
	controls,
}: Props = $props();
</script>

<header class="entry-header" data-kind={kind}>
	<span class="entry-icon" aria-hidden="true">
		<Icon name={kind === 'system' ? 'automatic' : kind === 'operator' ? 'human' : kind === 'prompt' || kind === 'result' ? 'document' : kind} />
		{#if failed}<svg class="failure-badge" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="var(--chronicle-danger)" stroke="var(--chronicle-card-surface)" stroke-width="1.5" /><path d="M8 4.5v4M8 11v.5" stroke="white" stroke-width="1.5" stroke-linecap="round" /></svg>{/if}
	</span>
	<div class="entry-heading">
		<h3>{title}</h3>
		{#if metadata}<p class="entry-metadata">{metadata}</p>{/if}
	</div>
	<div class="entry-timing">
		{#if timestamp}<time datetime={timestamp} title={new Date(timestamp).toLocaleString()}>{formatRelativeTime(timestamp)}</time>{/if}
		{#if timestamp && duration}<span aria-hidden="true">·</span>{/if}
		{#if duration}<span>{duration}</span>{/if}
	</div>
	<div class="entry-controls">{#if controls}{@render controls()}{/if}</div>
</header>

<style>
	.entry-header { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto 28px; align-items: start; gap: 10px; min-width: 0; }
	.entry-icon { position: relative; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: var(--chronicle-panel-muted); color: var(--chronicle-text-muted); }
	.entry-icon :global(svg) { width: 20px; height: 20px; }
	.entry-icon .failure-badge { position: absolute; top: 0; right: -5px; width: 16px; height: 16px; }
	[data-kind="llm"] .entry-icon { color: var(--chronicle-accent); background: color-mix(in srgb, var(--chronicle-accent) 9%, var(--chronicle-card-surface)); }
	.entry-heading { min-width: 0; padding-top: 3px; }
	h3 { margin: 0; font-size: var(--type-body-lg); line-height: 1.35; font-weight: 650; color: var(--chronicle-text); overflow-wrap: anywhere; }
	.entry-metadata { margin: 2px 0 0; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); line-height: 1.45; overflow-wrap: anywhere; }
	.entry-timing { display: flex; align-items: center; gap: 6px; padding-top: 5px; color: var(--chronicle-text-faint); font-size: var(--type-caption); line-height: 1.5; font-variant-numeric: tabular-nums; white-space: nowrap; }
	.entry-controls { display: flex; justify-content: end; width: 28px; min-height: 28px; }
	@media (max-width: 540px) {
		.entry-header { grid-template-columns: 26px minmax(0, 1fr) auto 24px; gap: 6px; }
		.entry-icon { width: 26px; height: 26px; }
		.entry-icon :global(svg) { width: 17px; height: 17px; }
		.entry-heading { padding-top: 2px; }
		h3 { font-size: var(--type-body); }
		.entry-timing { gap: 4px; font-size: 11px; padding-top: 4px; }
		.entry-controls { width: 24px; }
	}
</style>

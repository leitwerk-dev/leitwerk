<script lang="ts">
import type {
	PrimaryPathToolCallSnapshot,
	TurnTraceToolCallSnapshot,
} from "@leitwerk-dev/protocol";
import type { ToolCallRendererDefinition } from "../../lib/api";
import { formatDefinition } from "../../lib/format";
import { resolveToolRenderer, resolveToolRendererFields } from "../../lib/tool-call-rendering.js";
import { formatStructuredValue, summarizeToolPayload } from "../lib/tool-call-summary.js";
import ChronicleMarkdown from "./ChronicleMarkdown.svelte";

type DisplayToolCallSnapshot = PrimaryPathToolCallSnapshot | TurnTraceToolCallSnapshot;

interface Props {
	toolCall: DisplayToolCallSnapshot;
	toolRendererIndex: Record<string, ToolCallRendererDefinition>;
}

const INTERNAL_TOOL_NAMES = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"web_search",
	"web_scrape",
	"headroom_retrieve",
	"headroom_stats",
	"parallel",
]);

let { toolCall, toolRendererIndex }: Props = $props();
let isOpen = $state(false);
let observedToolCallId = $state<string | null>(null);

$effect(() => {
	if (observedToolCallId === toolCall.toolCallId) {
		return;
	}
	observedToolCallId = toolCall.toolCallId;
	isOpen = toolCall.status === "running";
});

function handleToggle(event: Event) {
	isOpen = (event.currentTarget as HTMLDetailsElement).open;
}

function rendererFor(toolName: string): ToolCallRendererDefinition | null {
	return resolveToolRenderer(toolRendererIndex, toolName);
}

function parseTimestamp(value: string | null | undefined): number | null {
	if (!value) {
		return null;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function formatStartAndDurationLabel(
	startedAt: string | null | undefined,
	completedAt: string | null | undefined,
): string {
	const startedLabel =
		typeof startedAt === "string" && startedAt.trim() !== "" ? startedAt : "Unknown";
	const start = parseTimestamp(startedAt);
	const end = parseTimestamp(completedAt);
	if (start === null || end === null || end < start) {
		return `Started ${startedLabel} · Duration ${completedAt ? "Unknown" : "Running"}`;
	}
	const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
	const durationLabel =
		totalSeconds < 1
			? "<1s"
			: totalSeconds < 60
				? `${totalSeconds}s`
				: `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
	return `Started ${startedLabel} · Duration ${durationLabel}`;
}

function primaryArgumentSummary(toolCall: DisplayToolCallSnapshot): string | null {
	const args = toolCall.arguments;
	if (!args) {
		return null;
	}
	switch (toolCall.toolName) {
		case "read":
		case "write":
		case "edit":
			return typeof args.path === "string" ? args.path : summarizeToolPayload(args, 1);
		case "bash":
			return typeof args.command === "string" ? args.command : summarizeToolPayload(args, 1);
		case "web_search":
			return typeof args.query === "string" ? args.query : summarizeToolPayload(args, 1);
		case "web_scrape":
			return typeof args.url === "string" ? args.url : summarizeToolPayload(args, 1);
		case "headroom_retrieve":
			return typeof args.hash === "string" ? args.hash : summarizeToolPayload(args, 1);
		default:
			return summarizeToolPayload(args, 1);
	}
}

const renderer = $derived(rendererFor(toolCall.toolName));
const fields = $derived(
	resolveToolRendererFields(
		{
			arguments: toolCall.arguments,
			result: "result" in toolCall ? toolCall.result : null,
		},
		renderer,
	),
);
const isBuiltInTool = $derived(INTERNAL_TOOL_NAMES.has(toolCall.toolName));
const toolKind = $derived(isBuiltInTool ? "internal" : "custom");
const title = $derived(
	renderer?.title ?? (isBuiltInTool ? toolCall.toolName : formatDefinition(toolCall.toolName)),
);
const resultText = $derived("resultText" in toolCall ? toolCall.resultText : null);
const isToolTruncated = $derived("truncated" in toolCall && toolCall.truncated);
const argumentSummary = $derived(primaryArgumentSummary(toolCall));
const runMetaLabel = $derived(
	formatStartAndDurationLabel(toolCall.startedAt, toolCall.completedAt),
);
const statusLabel = $derived(
	toolCall.isError ? "Failed" : toolCall.status === "running" ? "Running" : "Completed",
);
const statusSymbol = $derived(toolCall.isError ? "✕" : toolCall.status === "running" ? "…" : "✓");
const statusTone = $derived(
	toolCall.isError ? "error" : toolCall.status === "running" ? "running" : "success",
);
</script>

{#snippet toolSummaryContent()}
	<div class="tool-summary-copy">
		<p class="tool-inline-copy">
			<span class="tool-name">{title}</span>
			{#if argumentSummary}
				<span class="tool-arguments">{argumentSummary}</span>
			{/if}
		</p>
	</div>
	<div class="tool-summary-badges">
		{#if isToolTruncated}
			<span class="tool-badge tool-badge-warning">truncated</span>
		{/if}
		<span class="tool-status" data-tone={statusTone} aria-label={statusLabel}>
			<span aria-hidden="true">{statusSymbol}</span>
		</span>
	</div>
{/snippet}

<details
	class="tool-item tool-item-expandable"
	open={isOpen}
	data-section="reasoning-tool-marker"
	data-tool-kind={toolKind}
	data-tool-name={toolCall.toolName}
	data-tool-status={toolCall.isError ? "failed" : toolCall.status}
	data-tool-truncated={isToolTruncated ? "true" : "false"}
	ontoggle={handleToggle}
>
	<summary class="tool-summary">
		{@render toolSummaryContent()}
	</summary>

	{#if isOpen}
		<div class="tool-details">
			<div class="tool-meta-line" data-section="tool-run-meta">
				<span class="tool-status-chip" data-tone={statusTone}>
					<span aria-hidden="true">{statusSymbol}</span>
					<span>{statusLabel}</span>
				</span>
				<span>{runMetaLabel}</span>
			</div>

			{#if isToolTruncated}
				<div class="tool-warning" role="status" data-section="tool-truncation-warning">
					<p class="tool-warning-title">Tool result truncated</p>
					<p class="tool-warning-copy">The tool result was too large to show completely.</p>
				</div>
			{/if}

			{#if fields.length > 0}
				<div class="renderer-field-list" data-section="tool-renderer-fields">
					{#each fields as field (field.id)}
						<div class="renderer-field">
							<p class="payload-label">{field.label}</p>
							{#if field.kind === "markdown" && typeof field.value === "string"}
								<ChronicleMarkdown markdown={field.value} className="tool-field-markdown" />
							{:else}
								<pre class="payload-block">{formatStructuredValue(field.value)}</pre>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<div class="payload-summary-list" data-section="tool-session-details">
				<div class="payload-summary-row">
					<p class="payload-label">Inputs</p>
					{#if toolCall.arguments}
						<pre class="payload-block">{formatStructuredValue(toolCall.arguments)}</pre>
					{:else}
						<p class="payload-summary empty-summary">No inputs were recorded.</p>
					{/if}
				</div>
				{#if resultText}
					<div class="payload-summary-row">
						<p class="payload-label">Result</p>
						<pre class:payload-summary-error={toolCall.isError} class="payload-block">{resultText}</pre>
					</div>
				{:else}
					<p class="payload-summary empty-summary">No result text was recorded.</p>
				{/if}
			</div>
		</div>
	{/if}
</details>

<style>
	.tool-item {
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
		background: color-mix(in srgb, var(--chronicle-panel-muted) 72%, white 28%);
		flex: 0 0 auto;
		align-self: stretch;
		min-width: 0;
	}

	.tool-item[data-tool-status="failed"] {
		border-color: var(--chronicle-danger-border);
		background: var(--chronicle-danger-surface-soft);
	}

	.tool-item[data-tool-truncated="true"] {
		border-color: color-mix(in srgb, var(--chronicle-warning, #d97706) 42%, var(--chronicle-border) 58%);
		background: color-mix(in srgb, white 89%, var(--chronicle-warning, #d97706) 11%);
	}

	.tool-item-expandable {
		display: block;
		overflow: hidden;
	}

	.tool-item-expandable[open] {
		border-color: color-mix(in srgb, var(--chronicle-accent) 20%, var(--chronicle-border) 80%);
		background: color-mix(in srgb, white 94%, var(--chronicle-accent-soft) 6%);
	}

	.tool-item-expandable[open][data-tool-truncated="true"] {
		border-color: color-mix(in srgb, var(--chronicle-warning, #d97706) 48%, var(--chronicle-accent) 20%);
		background: color-mix(in srgb, white 90%, var(--chronicle-warning, #d97706) 10%);
	}

	.tool-summary {
		list-style: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		padding: 9px 12px;
		min-width: 0;
	}

	.tool-summary::-webkit-details-marker {
		display: none;
	}

	.tool-summary-copy {
		min-width: 0;
		flex: 1;
	}

	.tool-inline-copy {
		margin: 0;
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}

	.tool-name {
		flex-shrink: 0;
		font-size: var(--type-body-sm);
		font-weight: 650;
		line-height: 1.5;
		color: var(--chronicle-text);
	}

	.tool-arguments {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--type-body-sm);
		line-height: 1.5;
		color: var(--chronicle-text-muted);
	}

	.tool-summary-badges {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.tool-status,
	.tool-badge {
		font-size: var(--type-label);
		font-weight: 700;
		letter-spacing: var(--tracking-label);
		text-transform: uppercase;
	}

	.tool-status {
		display: inline-grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--chronicle-panel-muted) 74%, white 26%);
		color: var(--chronicle-text-muted);
	}

	.tool-status[data-tone="success"] {
		background: color-mix(in srgb, #16a34a 12%, white 88%);
		color: #166534;
	}

	.tool-status[data-tone="running"] {
		background: color-mix(in srgb, var(--chronicle-accent) 12%, white 88%);
		color: var(--chronicle-accent);
	}

	.tool-status[data-tone="error"] {
		background: var(--chronicle-danger-surface-soft);
		color: var(--chronicle-danger-text);
	}

	.tool-badge {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 0 8px;
		border-radius: 999px;
	}

	.tool-badge-warning {
		border: 1px solid color-mix(in srgb, var(--chronicle-warning, #d97706) 42%, white 58%);
		background: color-mix(in srgb, white 82%, var(--chronicle-warning, #d97706) 18%);
		color: color-mix(in srgb, var(--chronicle-warning, #d97706) 72%, #111827 28%);
	}

	.payload-summary-error {
		color: var(--chronicle-danger-text);
	}

	.tool-details {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 0 12px 12px;
	}

	.renderer-field-list,
	.payload-summary-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.renderer-field,
	.payload-summary-row {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.payload-label {
		margin: 0;
		font-size: var(--type-label);
		font-weight: 700;
		letter-spacing: var(--tracking-label);
		text-transform: uppercase;
		color: var(--chronicle-text-muted);
	}

	.payload-summary,
	.empty-summary {
		margin: 0;
		font-size: var(--type-body-sm);
		line-height: 1.6;
		color: var(--chronicle-text);
	}

	.tool-warning {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 14px;
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, var(--chronicle-warning, #d97706) 32%, var(--chronicle-border) 68%);
		background: color-mix(in srgb, white 90%, var(--chronicle-warning, #d97706) 10%);
	}

	.tool-warning-title,
	.tool-warning-copy {
		margin: 0;
	}

	.tool-warning-title {
		font-size: var(--type-body-sm);
		font-weight: 700;
		color: color-mix(in srgb, var(--chronicle-warning, #d97706) 72%, #111827 28%);
	}

	.tool-warning-copy {
		font-size: var(--type-body-sm);
		line-height: 1.55;
		color: var(--chronicle-text);
	}

	.tool-meta-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-size: var(--type-body-sm);
		line-height: 1.5;
		color: var(--chronicle-text-muted);
	}

	.tool-status-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 8px;
		border-radius: 999px;
		font-size: var(--type-label);
		font-weight: 700;
		letter-spacing: var(--tracking-label);
		text-transform: uppercase;
	}

	.tool-status-chip[data-tone="success"] {
		background: color-mix(in srgb, #16a34a 12%, white 88%);
		color: #166534;
	}

	.tool-status-chip[data-tone="running"] {
		background: color-mix(in srgb, var(--chronicle-accent) 12%, white 88%);
		color: var(--chronicle-accent);
	}

	.tool-status-chip[data-tone="error"] {
		background: var(--chronicle-danger-surface-soft);
		color: var(--chronicle-danger-text);
	}

	.payload-block {
		margin: 0;
		padding: 12px 14px;
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
		background: var(--chronicle-code-surface);
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.55;
		font-variant-numeric: tabular-nums;
		tab-size: 2;
		white-space: pre-wrap;
		color: var(--chronicle-text);
		max-height: 360px;
		overflow: auto;
	}
</style>

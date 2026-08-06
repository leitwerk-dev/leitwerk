<script module lang="ts">
let nextFlowDiagramInstanceId = 0;
</script>

<script lang="ts">
import type { ProcessFlowNode, ProcessFlowView, UiLauncherSummary } from "../lib/api.js";
import {
	computeFlowLayout,
	edgeDisplayLabel,
	type FlowLayout,
	type FlowLayoutEdge,
	type FlowLayoutNode,
	turnTypeDescription,
	turnTypeLabel,
} from "../lib/flow-layout.js";

type Mode = "happy" | "full";

interface Props {
	/** Provide either a launcher (gallery/setup) or a flow view directly (detail page). */
	launcher?: UiLauncherSummary;
	flow?: ProcessFlowView;
	mode?: Mode;
	compact?: boolean;
	/**
	 * When true, render the compact happy strip by default with a disclosure
	 * toggle that expands the full directed chart in place. Keeps the initial
	 * page view light for users who already know the flow.
	 */
	expandable?: boolean;
}

let { launcher, flow, mode = "happy", compact = false, expandable = false }: Props = $props();

let expanded = $state(false);

const flowView = $derived<ProcessFlowView | null>(flow ?? launcher?.processFlow ?? null);

const nodesByTurnId = $derived(
	new Map((flowView?.nodes ?? []).map((node) => [node.turnId, node] as const)),
);

// Happy mode shows just the spine as a compact strip.
const spineNodes = $derived<ProcessFlowNode[]>(
	(flowView?.spine ?? [])
		.map((turnId) => nodesByTurnId.get(turnId))
		.filter((node): node is ProcessFlowNode => node !== undefined),
);

const completedEndState = $derived(
	(flowView?.endStates ?? []).find((state) => state.lifecycleStatus === "completed") ?? null,
);

// The full chart renders when explicitly requested, or when an expandable
// instance is currently expanded.
const wantsFullChart = $derived(mode === "full" || (expandable && expanded));

// Full mode lays the whole graph out as a real directed flow chart.
const layout = $derived<FlowLayout | null>(
	flowView && wantsFullChart ? computeFlowLayout(flowView) : null,
);

function edgePath(edge: FlowLayoutEdge): string {
	const points = edge.points;
	if (points.length === 0) {
		return "";
	}
	if (points.length === 1) {
		return `M ${points[0].x} ${points[0].y}`;
	}
	// Smooth the routed polyline with quadratic segments through midpoints.
	let path = `M ${points[0].x} ${points[0].y}`;
	for (let index = 1; index < points.length - 1; index += 1) {
		const current = points[index];
		const next = points[index + 1];
		const midX = (current.x + next.x) / 2;
		const midY = (current.y + next.y) / 2;
		path += ` Q ${current.x} ${current.y} ${midX} ${midY}`;
	}
	const last = points[points.length - 1];
	path += ` L ${last.x} ${last.y}`;
	return path;
}

function nodeClasses(node: FlowLayoutNode): string {
	if (node.kind === "end") {
		return `flow-box is-end is-${node.lifecycleStatus}`;
	}
	const role = node.role === "spine" ? "is-spine" : "is-branch";
	return `flow-box is-turn ${role}`;
}

const markerPrefix = `process-flow-${nextFlowDiagramInstanceId++}`;
const chartId = `${markerPrefix}-chart`;

function markerId(kind: FlowLayoutEdge["kind"]): string {
	return `${markerPrefix}-arrow-${kind}`;
}

const edgeKinds = ["forward", "loopback", "branch", "terminal"] as const;

const hasSpine = $derived(flowView !== null && spineNodes.length > 0);
const showFullChart = $derived(flowView !== null && (layout?.nodes.length ?? 0) > 0);

// Branch / offshoot turns (recovery, review loops) shown only in the full chart.
const branchNodes = $derived<ProcessFlowNode[]>(
	(flowView?.nodes ?? []).filter((node) => node.role === "branch"),
);

// Distinct edge kinds actually present, so the legend only explains what is drawn.
const presentEdgeKinds = $derived(
	new Set((layout?.edges ?? []).map((edge) => edge.kind)),
);

const endStates = $derived(flowView?.endStates ?? []);

// Authoritative accessible name for a turn node: what it is, its kind, and what
// happens there. Surfaced to assistive tech via the node's aria-label, and to
// mouse users as the same sentence in a hover <title>.
function nodeAriaLabel(node: FlowLayoutNode): string {
	if (node.kind === "end") {
		return `End state: ${node.title}`;
	}
	if (node.turnType) {
		return `${node.title}. ${turnTypeLabel(node.turnType)}. ${turnTypeDescription(node.turnType)}`;
	}
	return node.title;
}

const legendId = `${markerPrefix}-legend`;

// One-sentence narrative of the whole graph for assistive tech, so a screen
// reader user gets the same orientation the sighted user gets from the chart.
const accessibleSummary = $derived.by(() => {
	if (!flowView) {
		return "";
	}
	const parts: string[] = [];
	const happy = spineNodes.map((node) => node.description).join(", then ");
	if (happy) {
		parts.push(`Happy path: ${happy}.`);
	}
	if (branchNodes.length > 0) {
		parts.push(
			`Branch and recovery steps: ${branchNodes.map((node) => node.description).join(", ")}.`,
		);
	}
	if (endStates.length > 0) {
		const ends = endStates
			.map((state) => (state.lifecycleStatus === "completed" ? "Completed" : "Aborted"))
			.join(" or ");
		parts.push(`Ends in: ${ends}.`);
	}
	return parts.join(" ");
});
</script>

{#snippet happyStrip()}
	<ol
		class={["process-flow", compact && "is-compact"]}
		data-section="process-flow-diagram"
		data-flow-mode="happy"
		aria-label="Happy path"
	>
		{#each spineNodes as node, index (node.turnId)}
			<li class="flow-step" data-flow-turn-id={node.turnId}>
				<span class="step-chip" data-turn-type={node.turnType}>{node.description}</span>
				{#if index < spineNodes.length - 1}
					<span class="step-arrow" aria-hidden="true">→</span>
				{/if}
			</li>
		{/each}
		{#if completedEndState}
			<li class="flow-step" data-flow-end-state="completed">
				<span class="step-arrow" aria-hidden="true">→</span>
				<span class="end-chip is-completed">Completed</span>
			</li>
		{/if}
	</ol>
{/snippet}

{#snippet fullChart()}
	{#if layout && layout.nodes.length > 0}
	<figure
		class="process-flow-chart"
		data-section="process-flow-diagram"
		data-flow-mode="full"
	>
		<p id={`${markerPrefix}-desc`} class="sr-only">{accessibleSummary}</p>
		<div class="flow-svg-viewport">
		<svg
			viewBox={`0 0 ${layout.width} ${layout.height}`}
			preserveAspectRatio="xMidYMid meet"
			class="flow-svg"
			role="group"
			aria-label="Process flow chart"
			aria-describedby={`${markerPrefix}-desc`}
		>
			<defs>
				{#each edgeKinds as kind (kind)}
					<marker
						id={markerId(kind)}
						class={`flow-marker is-${kind}`}
						viewBox="0 0 10 10"
						refX="9"
						refY="5"
						markerWidth="7"
						markerHeight="7"
						orient="auto-start-reverse"
					>
						<path d="M 0 0 L 10 5 L 0 10 z" />
					</marker>
				{/each}
			</defs>

			<g class="flow-edges" aria-hidden="true">
				{#each layout.edges as edge (edge.id)}
					{@const displayLabel = edgeDisplayLabel(edge.labels)}
					<path
						class={`flow-edge is-${edge.kind}`}
						d={edgePath(edge)}
						fill="none"
						marker-end={`url(#${markerId(edge.kind)})`}
						data-flow-edge-kind={edge.kind}
						data-flow-edge-from={edge.from}
						data-flow-edge-to={edge.to}
					/>
					{#if displayLabel && edge.labelX !== null && edge.labelY !== null}
						<g
							class={["flow-edge-label", edge.labels.length > 1 && "is-multi"]}
							transform={`translate(${edge.labelX}, ${edge.labelY})`}
							data-flow-edge-label-from={edge.from}
							data-flow-edge-label-to={edge.to}
							data-flow-edge-label-count={edge.labels.length}
						>
							<rect
								class="flow-edge-label-bg"
								x={-(displayLabel.length * 3.4 + 6)}
								y="-9"
								width={displayLabel.length * 6.8 + 12}
								height="18"
								rx="5"
							/>
							<text class="flow-edge-label-text" x="0" y="0" dominant-baseline="middle" text-anchor="middle">
								{displayLabel}
							</text>
							{#if edge.labels.length > 1}
								<title>{edge.labels.join("\n")}</title>
							{/if}
						</g>
					{/if}
				{/each}
			</g>

			<g class="flow-nodes" role="list" aria-label="Process steps">
				{#each layout.nodes as node (node.id)}
					<g
						class={nodeClasses(node)}
						transform={`translate(${node.x - node.width / 2}, ${node.y - node.height / 2})`}
						data-flow-turn-id={node.kind === "turn" ? node.id : undefined}
						data-flow-end-state={node.kind === "end" ? node.lifecycleStatus : undefined}
						data-flow-node-role={node.role ?? undefined}
						role="listitem"
						aria-label={nodeAriaLabel(node)}
					>
						{#if node.kind === "turn" && node.turnType}
							<title>{turnTypeDescription(node.turnType)}</title>
						{/if}
						<rect
							class="flow-box-rect"
							width={node.width}
							height={node.height}
							rx={node.kind === "end" ? 9 : 13}
						/>
						{#if node.isEntry}
							<rect class="flow-entry-tab" x="0" y="0" width={node.width} height="3" rx="1.5" />
						{/if}
						<text
							class="flow-box-title"
							x={node.width / 2}
							y={node.kind === "end" ? node.height / 2 : node.height / 2 - 7}
							text-anchor="middle"
							dominant-baseline="middle"
						>
							{node.title}
						</text>
						{#if node.kind === "turn"}
							<text
								class="flow-box-subtitle"
								x={node.width / 2}
								y={node.height / 2 + 10}
								text-anchor="middle"
								dominant-baseline="middle"
							>
								{node.subtitle}
							</text>
						{/if}
					</g>
				{/each}
			</g>
		</svg>
		</div>
		<figcaption id={legendId} class="flow-legend">
			<span class="flow-legend-item">
				<span class="flow-legend-swatch is-spine" aria-hidden="true"></span>
				Happy path
			</span>
			{#if branchNodes.length > 0}
				<span class="flow-legend-item">
					<span class="flow-legend-swatch is-branch" aria-hidden="true"></span>
					Branch step
				</span>
			{/if}
			{#if presentEdgeKinds.has("loopback")}
				<span class="flow-legend-item">
					<span class="flow-legend-line is-loopback" aria-hidden="true"></span>
					Loops back
				</span>
			{/if}
			{#each endStates as state (state.lifecycleStatus)}
				<span class="flow-legend-item">
					<span
						class={`flow-legend-swatch is-end is-${state.lifecycleStatus}`}
						aria-hidden="true"
					></span>
					{state.lifecycleStatus === "completed" ? "Completed" : "Aborted"}
				</span>
			{/each}
		</figcaption>
	</figure>
	{/if}
{/snippet}

{#if expandable && hasSpine}
	<div class="flow-disclosure" data-section="process-flow-disclosure">
		<div class="flow-disclosure-body">
			{#if expanded && showFullChart}
				<div id={chartId}>
					{@render fullChart()}
				</div>
			{:else}
				{@render happyStrip()}
			{/if}
		</div>
		<button
			type="button"
			class="flow-toggle"
			data-pressable="true"
			aria-expanded={expanded}
			aria-controls={chartId}
			onclick={() => (expanded = !expanded)}
		>
			<span class="flow-toggle-label">{expanded ? "Hide flow" : "Show full flow"}</span>
			<span class={["flow-toggle-caret", expanded && "is-open"]} aria-hidden="true">›</span>
		</button>
	</div>
{:else if mode === "happy" && hasSpine}
	{@render happyStrip()}
{:else if mode === "full" && showFullChart}
	{@render fullChart()}
{/if}

<style>
	/* Progressive-disclosure: body plus a static caret pinned top-right */
	.flow-disclosure {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		width: 100%;
	}

	.flow-disclosure-body {
		flex: 1 1 auto;
		min-width: 0;
	}

	/* A lightweight text + caret affordance, not a button. */
	.flow-toggle {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-top: 1px;
		padding: 4px 6px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--chronicle-text-muted);
		font: inherit;
		font-size: 0.78rem;
		font-weight: 640;
		cursor: pointer;
	}

	.flow-toggle:hover,
	.flow-toggle:focus-visible {
		color: var(--chronicle-text);
		background: color-mix(in srgb, var(--chronicle-text) 8%, transparent 92%);
		outline: none;
	}

	.flow-toggle-label {
		white-space: nowrap;
	}

	.flow-toggle-caret {
		display: inline-block;
		font-size: 1.05rem;
		line-height: 1;
		transition: transform 140ms ease;
	}

	.flow-toggle-caret.is-open {
		transform: rotate(90deg);
	}

	@media (prefers-reduced-motion: reduce) {
		.flow-toggle-caret {
			transition: none;
		}
	}

	/* Happy-path compact strip */
	.process-flow {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 0;
		margin: 0;
		list-style: none;
	}

	.flow-step {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.step-chip {
		display: inline-flex;
		align-items: center;
		min-height: 30px;
		padding: 5px 10px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 78%, transparent 22%);
		border-radius: 999px;
		background: color-mix(in srgb, var(--chronicle-card-surface) 86%, var(--chronicle-accent-soft) 14%);
		color: var(--chronicle-text);
		font-size: 0.78rem;
		font-weight: 620;
		line-height: 1.25;
	}

	.step-arrow {
		color: color-mix(in srgb, var(--chronicle-text-muted) 84%, var(--chronicle-accent) 16%);
		font-weight: 700;
	}

	.end-chip {
		display: inline-flex;
		align-items: center;
		min-height: 30px;
		padding: 5px 12px;
		border-radius: 8px;
		font-size: 0.78rem;
		font-weight: 680;
		line-height: 1.25;
	}

	.end-chip.is-completed {
		background: color-mix(in srgb, var(--chronicle-success, #2f9e63) 18%, var(--chronicle-card-surface) 82%);
		border: 1px solid color-mix(in srgb, var(--chronicle-success, #2f9e63) 42%, transparent 58%);
		color: color-mix(in srgb, var(--chronicle-success, #2f9e63) 72%, var(--chronicle-text) 28%);
	}

	.is-compact {
		gap: 6px;
	}

	.is-compact .flow-step {
		gap: 6px;
	}

	.is-compact .step-chip,
	.is-compact .end-chip {
		min-height: 26px;
		padding: 4px 8px;
		font-size: 0.73rem;
	}

	/* Full SVG flow chart */
	.process-flow-chart {
		width: 100%;
		margin: 0;
		padding: 4px 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	/*
	 * Bound the chart so expanding it orients the operator without shoving the
	 * setup form below the fold. The SVG scales to fit within this box (meet),
	 * and the box scrolls only when the graph is genuinely larger than the cap.
	 */
	.flow-svg-viewport {
		width: 100%;
		overflow: auto;
	}

	.flow-svg {
		display: block;
		width: 100%;
		height: auto;
		max-height: clamp(260px, 42vh, 520px);
		font-family: inherit;
	}

	/* Legend / key for the chart's visual language. */
	.flow-legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 16px;
		margin: 0;
		padding: 0;
		color: var(--chronicle-text-muted);
		font-size: 0.72rem;
		font-weight: 600;
	}

	.flow-legend-item {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
	}

	.flow-legend-swatch {
		display: inline-block;
		width: 16px;
		height: 12px;
		border-radius: 4px;
		background: color-mix(in srgb, var(--chronicle-card-surface) 92%, var(--chronicle-accent-soft) 8%);
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 78%, transparent 22%);
	}

	.flow-legend-swatch.is-spine {
		background: color-mix(in srgb, var(--chronicle-card-surface) 76%, var(--chronicle-accent-soft) 24%);
		border-color: color-mix(in srgb, var(--chronicle-accent) 42%, var(--chronicle-border) 58%);
	}

	.flow-legend-swatch.is-branch {
		border-style: dashed;
	}

	.flow-legend-swatch.is-end.is-completed {
		background: color-mix(in srgb, var(--chronicle-success, #2f9e63) 16%, var(--chronicle-card-surface) 84%);
		border-color: color-mix(in srgb, var(--chronicle-success, #2f9e63) 48%, transparent 52%);
	}

	.flow-legend-swatch.is-end.is-aborted {
		background: color-mix(in srgb, var(--chronicle-danger, #c4453f) 13%, var(--chronicle-card-surface) 87%);
		border-color: color-mix(in srgb, var(--chronicle-danger, #c4453f) 46%, transparent 54%);
	}

	.flow-legend-line {
		display: inline-block;
		width: 18px;
		height: 0;
		border-top: 2px dashed color-mix(in srgb, #d08a1e 64%, var(--chronicle-text-muted) 36%);
	}

	.flow-box-rect {
		fill: color-mix(in srgb, var(--chronicle-card-surface) 92%, var(--chronicle-accent-soft) 8%);
		stroke: color-mix(in srgb, var(--chronicle-border) 78%, transparent 22%);
		stroke-width: 1.2;
	}

	.is-turn {
		cursor: help;
	}

	.is-spine .flow-box-rect {
		fill: color-mix(in srgb, var(--chronicle-card-surface) 76%, var(--chronicle-accent-soft) 24%);
		stroke: color-mix(in srgb, var(--chronicle-accent) 42%, var(--chronicle-border) 58%);
		stroke-width: 1.6;
	}

	.is-branch .flow-box-rect {
		stroke-dasharray: 4 3;
	}

	.is-end.is-completed .flow-box-rect {
		fill: color-mix(in srgb, var(--chronicle-success, #2f9e63) 16%, var(--chronicle-card-surface) 84%);
		stroke: color-mix(in srgb, var(--chronicle-success, #2f9e63) 48%, transparent 52%);
		stroke-width: 1.6;
	}

	.is-end.is-aborted .flow-box-rect {
		fill: color-mix(in srgb, var(--chronicle-danger, #c4453f) 13%, var(--chronicle-card-surface) 87%);
		stroke: color-mix(in srgb, var(--chronicle-danger, #c4453f) 46%, transparent 54%);
		stroke-width: 1.6;
	}

	.flow-entry-tab {
		fill: color-mix(in srgb, var(--chronicle-accent) 70%, var(--chronicle-text) 30%);
	}

	.flow-box-title {
		fill: var(--chronicle-text);
		font-size: 12.5px;
		font-weight: 640;
	}

	.is-end .flow-box-title {
		font-weight: 700;
	}

	.is-end.is-completed .flow-box-title {
		fill: color-mix(in srgb, var(--chronicle-success, #2f9e63) 70%, var(--chronicle-text) 30%);
	}

	.is-end.is-aborted .flow-box-title {
		fill: color-mix(in srgb, var(--chronicle-danger, #c4453f) 68%, var(--chronicle-text) 32%);
	}

	.flow-box-subtitle {
		fill: var(--chronicle-text-muted);
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 0.03em;
		text-transform: uppercase;
	}

	.flow-edge {
		stroke-width: 1.6;
	}

	.flow-edge.is-forward {
		stroke: color-mix(in srgb, var(--chronicle-accent) 56%, var(--chronicle-text-muted) 44%);
		stroke-width: 2;
	}

	.flow-edge.is-branch {
		stroke: color-mix(in srgb, var(--chronicle-text-muted) 70%, transparent 30%);
	}

	.flow-edge.is-loopback {
		stroke: color-mix(in srgb, #d08a1e 64%, var(--chronicle-text-muted) 36%);
		stroke-dasharray: 5 4;
	}

	.flow-edge.is-terminal {
		stroke: color-mix(in srgb, var(--chronicle-text-muted) 78%, transparent 22%);
	}

	.flow-marker path {
		fill: var(--chronicle-text-muted);
	}

	.flow-marker.is-forward path {
		fill: color-mix(in srgb, var(--chronicle-accent) 56%, var(--chronicle-text-muted) 44%);
	}

	.flow-marker.is-loopback path {
		fill: color-mix(in srgb, #d08a1e 64%, var(--chronicle-text-muted) 36%);
	}

	.flow-edge-label-bg {
		fill: color-mix(in srgb, var(--chronicle-card-surface) 90%, transparent 10%);
		stroke: color-mix(in srgb, var(--chronicle-border) 70%, transparent 30%);
		stroke-width: 0.8;
	}

	.flow-edge-label-text {
		fill: var(--chronicle-text-muted);
		font-size: 9.5px;
		font-weight: 620;
	}

	.flow-edge-label.is-multi {
		cursor: help;
	}

	.flow-edge-label.is-multi .flow-edge-label-bg {
		fill: color-mix(in srgb, var(--chronicle-accent-soft) 30%, var(--chronicle-card-surface) 70%);
		stroke: color-mix(in srgb, var(--chronicle-accent) 40%, var(--chronicle-border) 60%);
	}

	.flow-edge-label.is-multi .flow-edge-label-text {
		fill: color-mix(in srgb, var(--chronicle-accent) 60%, var(--chronicle-text) 40%);
		font-weight: 700;
	}
</style>

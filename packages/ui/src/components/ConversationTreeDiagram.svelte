<script module lang="ts">
let nextTreeDiagramId = 0;
</script>

<script lang="ts">
import type { ProcessInstanceTreeResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import type { ChronicleSelectableItem } from "../chronicle/lib/chronicle-selectable-items.js";
import {
	INSTANCE_TREE_COLUMN_GAP,
	layoutInstanceTree,
	type InstanceTreeLayoutEdge,
} from "../lib/instance-tree-layout";

interface Props {
	tree: ProcessInstanceTreeResponseBody;
	railItems: readonly ChronicleSelectableItem[];
}

let { tree, railItems }: Props = $props();
const railByRecord = $derived(
	new Map(
		railItems
			.filter((item) => item.kind === "turn")
			.map((item) => [item.turnRecordId, item]),
	),
);
const markerId = `tree-arrow-${nextTreeDiagramId++}`;
const layout = $derived(layoutInstanceTree(tree.nodes, tree.currentLeafId, tree.edges));
const laneStarts = $derived(layout?.nodes.filter((node) => node.startsLane) ?? []);
const branchPoints = $derived(
	layout?.nodes.filter((node) => node.childCount > 1).length ?? 0,
);

function path(points: readonly { x: number; y: number }[]): string {
	return points
		.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
		.join(" ");
}

function marker(node: NonNullable<typeof layout>["nodes"][number]): string {
	const parts = [railByRecord.get(node.id)?.title ?? node.label];
	if (node.contextOrigin === "fresh") parts.push("fresh context");
	if (node.contextOrigin === "previous") parts.push("branch with previous context");
	if (node.childCount > 1) parts.push("branch point");
	if (node.isCurrent) parts.push("current input");
	if (node.resultState === "failed") parts.push("failed");
	return parts.join(", ");
}

function edgeLabels(edge: InstanceTreeLayoutEdge): string[] {
	return [edge.actionLabel, ...edge.productLabels.map((label) => `${label} input`)].filter(
		(label): label is string => Boolean(label),
	);
}

function isInlineContextEdge(edge: InstanceTreeLayoutEdge): boolean {
	const source = layout?.nodes.find((node) => node.id === edge.sourceNodeId);
	const target = layout?.nodes.find((node) => node.id === edge.targetNodeId);
	return Boolean(source && target && source.lane === target.lane && !edge.productLabels.length);
}

function edgeLabelPosition(edge: InstanceTreeLayoutEdge): { x: number; y: number } {
	const last = edge.points.at(-1) ?? { x: 0, y: 0 };
	const previous = edge.points.at(-2) ?? last;
	const source = layout?.nodes.find((node) => node.id === edge.sourceNodeId);
	const target = layout?.nodes.find((node) => node.id === edge.targetNodeId);
	if (source && target && isInlineContextEdge(edge)) {
		return { x: (source.x + target.x) / 2, y: source.y - 7 };
	}
	const peers =
		layout?.edges.filter(
			(candidate) =>
				candidate.targetNodeId === edge.targetNodeId &&
				!isInlineContextEdge(candidate) &&
				edgeLabels(candidate).length,
		) ?? [];
	const peerIndex = Math.max(0, peers.findIndex((candidate) => candidate.id === edge.id));
	return {
		x: (previous.x + last.x) / 2,
		y: target ? target.y - target.height / 2 - 9 - peerIndex * 60 : last.y - 11,
	};
}

const accessibleDescription = $derived.by(() => {
	if (!layout) return "No conversation input lineage.";
	const nodes = layout.nodes.map((node) => marker(node)).join("; ");
	const edges = layout.edges
		.map((edge) => {
			const target = edge.targetNodeId ?? edge.endState ?? "no target";
			const label = edgeLabels(edge).join(" ") || (edge.hasContext ? "context" : "decision");
			return `${edge.sourceNodeId} to ${target}: ${label}`;
		})
		.join("; ");
	return `Inputs: ${nodes}. Connections: ${edges || "none"}.`;
});
</script>

{#if layout}
	<p class="summary-detail">
		{layout.nodes.length} model inputs · {layout.laneCount} contexts · {branchPoints} branch
		{branchPoints === 1 ? "point" : "points"}
	</p>
	<div class="tree-viewport" data-section="conversation-tree-diagram">
		<svg
			width={layout.width}
			height={layout.height}
			viewBox={`0 0 ${layout.width} ${layout.height}`}
			role="img"
			aria-labelledby={`${markerId}-title ${markerId}-description`}
		>
			<title id={`${markerId}-title`}>Conversation input lineage</title>
			<desc id={`${markerId}-description`}>{accessibleDescription}</desc>
			<defs>
				<marker
					id={`${markerId}-context`}
					viewBox="0 0 10 10"
					refX="9"
					refY="5"
					markerWidth="6"
					markerHeight="6"
					orient="auto-start-reverse"
				>
					<path class="context-arrowhead" d="M 0 0 L 10 5 L 0 10 z" />
				</marker>
				<marker
					id={`${markerId}-product`}
					viewBox="0 0 10 10"
					refX="9"
					refY="5"
					markerWidth="6"
					markerHeight="6"
					orient="auto-start-reverse"
				>
					<path class="product-arrowhead" d="M 0 0 L 10 5 L 0 10 z" />
				</marker>
			</defs>

			{#each laneStarts as node, index (node.id)}
				<g class="lane-label" transform={`translate(16 ${node.y - 13})`}>
					<text class="lane-number" y="0">Context {index + 1}</text>
					<text class:previous={node.contextOrigin === "previous"} y="20">
						{node.contextOrigin === "previous" ? "Previous context" : "Fresh context"}
					</text>
				</g>
			{/each}

			{#each layout.nodes as node (node.id)}
				{@const rail = railByRecord.get(node.id)}
				<g
					class="tree-node"
					class:branch={node.childCount > 1}
					class:current={node.isCurrent}
					class:failed={node.resultState === "failed"}
					transform={`translate(${node.x - node.width / 2} ${node.y - node.height / 2})`}
					data-tree-node="turn"
					data-context-origin={node.contextOrigin}
					data-rail-tone={rail?.tone}
				>
					<title>{marker(node)}</title>
					<rect width={node.width} height={node.height} rx="9" />
					<text class="node-title" x={node.width / 2} y="38" text-anchor="middle">
						{rail?.title ?? node.label}
					</text>
					{#if node.childCount > 1}
						<text class="badge branch-badge" x={node.width - 58} y="-8">Branch</text>
					{/if}
					{#if node.isCurrent}
						<text class="badge current-badge" x={node.width - 62} y={node.height + 17}>Current</text>
					{:else if node.resultState === "failed"}
						<text class="badge failed-badge" x={node.width - 52} y={node.height + 17}>Failed</text>
					{/if}
				</g>
			{/each}

			{#each layout.edges as edge (edge.id)}
				<path
					class="edge"
					class:product={edge.productLabels.length}
					class:decision={!edge.hasContext && !edge.productLabels.length}
					class:dead-end={edge.endState === "not_applied"}
					class:completed-end={edge.endState === "completed"}
					d={path(edge.points)}
					marker-end={edge.endState
						? undefined
						: `url(#${markerId}-${edge.productLabels.length ? "product" : "context"})`}
				/>
				{#if edge.endState}
					{@const endpoint = edge.points.at(-1) ?? { x: 0, y: 0 }}
					{#if edge.endState === "not_applied"}
						<g class="dead-end-marker" transform={`translate(${endpoint.x} ${endpoint.y})`}>
							<line x1="-5" y1="-5" x2="5" y2="5" />
							<line x1="5" y1="-5" x2="-5" y2="5" />
						</g>
					{:else}
						<g class="completed-end-marker" transform={`translate(${endpoint.x} ${endpoint.y})`}>
							<path d="M -6 0 L -2 5 L 7 -6" />
						</g>
					{/if}
				{/if}
			{/each}

			{#each layout.edges as edge (`label:${edge.id}`)}
				{@const labels = edgeLabels(edge)}
				{#if labels.length}
					{@const position = edgeLabelPosition(edge)}
					<foreignObject
						class="edge-label-group"
						class:product={edge.productLabels.length}
						x={position.x - INSTANCE_TREE_COLUMN_GAP / 2}
						y={position.y - 60}
						width={INSTANCE_TREE_COLUMN_GAP}
						height="60"
					>
						<div class="edge-label-box">
							<div class="edge-label">
								{#each labels as label (`${edge.id}:${label}`)}<span>{label}</span>{/each}
							</div>
						</div>
					</foreignObject>
				{/if}
			{/each}
		</svg>
	</div>
{/if}

<style>
	.summary-detail {
		margin: 0;
		color: var(--chronicle-text-muted);
		font-size: var(--type-caption);
		font-weight: 560;
		text-align: left;
	}

	.tree-viewport {
		overflow: auto;
		max-height: 58vh;
		min-height: 240px;
		border: 1px solid var(--chronicle-border);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--chronicle-panel-muted) 45%, white);
	}

	svg {
		display: block;
		min-width: 100%;
	}

	.edge {
		fill: none;
		stroke: var(--chronicle-text-faint);
		stroke-width: 1.6;
		stroke-linejoin: round;
	}

	.edge.product {
		stroke: var(--chronicle-success);
		stroke-dasharray: 5 4;
	}

	.edge.decision {
		stroke: var(--chronicle-accent);
	}

	.edge.dead-end {
		stroke: var(--chronicle-danger);
	}

	.edge.completed-end {
		stroke: var(--chronicle-success);
	}

	.dead-end-marker,
	.completed-end-marker {
		stroke-width: 2;
		stroke-linecap: round;
	}

	.dead-end-marker {
		stroke: var(--chronicle-danger);
	}

	.completed-end-marker {
		fill: none;
		stroke: var(--chronicle-success);
		stroke-linejoin: round;
	}

	.context-arrowhead {
		fill: var(--chronicle-text-faint);
	}

	.product-arrowhead {
		fill: var(--chronicle-success);
	}

	.edge-label-group {
		pointer-events: none;
		overflow: visible;
	}

	.edge-label-box {
		display: flex;
		align-items: end;
		justify-content: center;
		height: 100%;
		text-align: center;
	}

	.edge-label {
		display: flex;
		flex-direction: column;
		padding: 4px 8px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 72%, white 28%);
		border-radius: var(--radius-sm);
		background: var(--chronicle-card-surface);
		color: var(--chronicle-text-muted);
		font: 650 var(--type-label) system-ui, sans-serif;
		line-height: 14px;
	}

	.edge-label-group.product .edge-label {
		border-color: color-mix(in srgb, var(--chronicle-success) 48%, var(--chronicle-border) 52%);
		background: var(--chronicle-success-surface);
		color: var(--chronicle-success);
	}

	.tree-node rect {
		fill: white;
		stroke: var(--chronicle-border-strong);
		stroke-width: 1.5;
	}

	.tree-node text {
		fill: var(--chronicle-text);
		font-family: system-ui, sans-serif;
	}

	.tree-node .node-title {
		font-size: var(--type-caption);
		font-weight: 650;
	}

	.tree-node.branch rect {
		stroke: var(--chronicle-attention);
		stroke-width: 2;
	}

	.tree-node.current rect {
		fill: var(--chronicle-success-surface);
		stroke: var(--chronicle-success);
		stroke-width: 2.5;
	}

	.tree-node.failed rect {
		fill: var(--chronicle-danger-surface-soft);
		stroke: var(--chronicle-danger);
		stroke-width: 2;
	}

	.badge {
		font-size: var(--type-label);
		font-weight: 700;
	}

	.branch-badge {
		fill: var(--chronicle-attention) !important;
	}

	.current-badge {
		fill: var(--chronicle-success) !important;
	}

	.failed-badge {
		fill: var(--chronicle-danger) !important;
	}

	.lane-label text {
		fill: var(--chronicle-text-muted);
		font: 600 var(--type-label) system-ui, sans-serif;
	}

	.lane-label .lane-number {
		fill: var(--chronicle-text);
		font-size: var(--type-label);
		font-weight: 700;
	}

	.lane-label text.previous {
		fill: var(--chronicle-attention);
	}

</style>

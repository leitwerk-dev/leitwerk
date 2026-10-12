<svelte:options namespace="svg" />

<script lang="ts">
import type { Point, WorkflowEdge } from "./index.js";

let {
	id,
	section,
	path,
	active,
	muted,
	markerPrefix,
	arrowEnd = true,
	rework = false,
	label = [],
	labelPosition,
	repeatLabel = false,
	tabbable = true,
	accessibleLabel,
	describedBy,
	from,
	to,
	kind,
	onPreview,
	onExit,
}: {
	id: string;
	section: "outer" | "entry" | "exit" | "results" | "loop";
	path: string;
	active: boolean;
	muted: boolean;
	markerPrefix: string;
	arrowEnd?: boolean;
	rework?: boolean;
	label?: string[];
	labelPosition?: Point;
	repeatLabel?: boolean;
	tabbable?: boolean;
	accessibleLabel: string;
	describedBy?: string;
	from?: string;
	to?: string;
	kind?: WorkflowEdge["kind"];
	onPreview: (event: MouseEvent | FocusEvent | KeyboardEvent) => void;
	onExit: (event: MouseEvent | FocusEvent) => void;
} = $props();
let element: SVGGElement;
function activate(event: MouseEvent | KeyboardEvent) {
	if (event.type === "keydown") {
		const key = (event as KeyboardEvent).key;
		if (key !== "Enter" && key !== " ") return;
		event.preventDefault();
	}
	element.focus();
	onPreview(event);
}
</script>

<g bind:this={element} class="workflow-route" class:route-active={active} class:route-muted={muted} class:rework
  data-route-id={id} data-route-section={section} data-flow-edge-from={from} data-flow-edge-to={to} data-flow-edge-kind={kind}
  role="button" tabindex={tabbable ? 0 : -1} aria-label={accessibleLabel} aria-describedby={describedBy}
  onmouseenter={onPreview} onmouseleave={onExit} onfocus={onPreview} onblur={onExit} onclick={activate} onkeydown={activate}>
  <path class="route-hit" d={path} fill="none" stroke="transparent" />
  <path class="route-line" d={path} fill="none" stroke={active ? 'var(--graph-accent)' : rework ? 'var(--graph-amber)' : 'var(--graph-route)'} stroke-width={active ? 2.2 : 1.6}
    marker-end={arrowEnd ? `url(#${markerPrefix}-arrow-${active ? 'active' : rework ? 'loop' : 'normal'})` : undefined} />
  {#if label.length && labelPosition}
    <text class="route-label" class:repeat-label={repeatLabel} x={labelPosition.x} y={labelPosition.y} text-anchor="middle">
      {#each label as line, index}<tspan x={labelPosition.x} dy={index ? 11 : 0}>{line}</tspan>{/each}
    </text>
  {/if}
</g>

<style>
.workflow-route {cursor:pointer;}
.route-hit {pointer-events:stroke;stroke-width:var(--graph-route-hit-width,14px);}
/* The two internal paths share a fork; keep their hit areas within that gap. */
[data-route-section="loop"] .route-hit,[data-route-section="results"] .route-hit {stroke-width:min(var(--graph-route-hit-width,14px),20px);}
.route-line {pointer-events:none;}
.route-label {pointer-events:all;font-family:inherit;font-size:10px;font-weight:500;fill:var(--graph-muted);stroke:var(--graph-paper);stroke-width:8px;paint-order:stroke;stroke-linejoin:round;}
.repeat-label {stroke:var(--graph-tint);}
[data-route-section="results"] .route-label {font-size:9px;}
.rework .route-label {fill:var(--graph-amber);}
.route-active .route-label {fill:var(--graph-accent);font-weight:650;}
.route-muted {opacity:.4;}
.route-muted.rework {opacity:.7;}
.workflow-route:focus-visible {outline:none;}
.workflow-route:focus-visible .route-label {text-decoration:underline;text-underline-offset:3px;}
.workflow-route:focus-visible .route-line {stroke-width:2.8px;}
</style>

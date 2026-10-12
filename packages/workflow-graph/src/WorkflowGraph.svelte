<script lang="ts">
import type { ProcessFlowTool, ProcessFlowView } from "@leitwerk-dev/domain";
import { onMount, tick, untrack } from "svelte";
import {
	edgePath,
	layoutWorkflow,
	type Point,
	turnKindLabel,
	type WorkflowEdge,
	type WorkflowNode,
} from "./index.js";
import Icon from "./WorkflowIcon.svelte";
import Route from "./WorkflowRoute.svelte";

interface Target {
	nodeId: string;
	part: "turn" | "repeat" | "collect";
}
type RouteTarget = { part: "edge"; edgeId: string } | { part: "results" | "loop"; nodeId: string };
type HighlightTarget = Target | RouteTarget;
type Preview = HighlightTarget & { element: HTMLElement | SVGGElement };
let {
	flow,
	onInspectTurn,
	inspectorPlacement = "auto",
}: {
	flow: ProcessFlowView;
	onInspectTurn?: (turnId: string) => void;
	inspectorPlacement?: "auto" | "below";
} = $props();
const uid = $props.id();
const graph = $derived(layoutWorkflow(flow));
let selected = $state<Target | null>(null);
let preview = $state<Preview | null>(null);
let viewport = $state<HTMLDivElement>();
let root = $state<HTMLDivElement>();
let inspector = $state<HTMLElement>();
let tooltip = $state<HTMLDivElement>();
let opener: HTMLElement | null = null;
let scale = $state(1);
let automaticFit = true;
let authorDetails = $state(false);
let tooltipPosition = $state({ left: 0, top: 0 });
const active = $derived(preview ?? selected);
const chosen = $derived(graph.nodes.find((node) => node.id === selected?.nodeId));
const tooltipNode = $derived.by(() => {
	const value = preview;
	return value && value.part !== "edge" && !sameTarget(value, selected)
		? graph.nodes.find((node) => node.id === value.nodeId)
		: undefined;
});
const tooltipEdge = $derived.by(() => {
	const value = preview;
	return value?.part === "edge" ? graph.edges.find((edge) => edge.id === value.edgeId) : undefined;
});
const routes = $derived(graph.edges.filter((edge) => edge.from === chosen?.id));
const presentKinds = $derived([
	...new Set(graph.nodes.filter((node) => node.turnId !== null).map((node) => node.kind)),
]);
let processId: string | undefined;
$effect(() => {
	if (preview && tooltip) positionTooltip();
});
$effect(() => {
	if (flow.processId !== processId) {
		processId = flow.processId;
		untrack(() => {
			selected = null;
			preview = null;
			authorDetails = false;
			automaticFit = true;
		});
	}
	graph.width;
	untrack(() => {
		if (automaticFit) void tick().then(fit);
	});
});

onMount(() => {
	root?.addEventListener("keydown", onKey);
	return () => root?.removeEventListener("keydown", onKey);
});
onMount(() => {
	fit();
	if (typeof ResizeObserver === "undefined" || !viewport) return;
	let previousWidth = viewport.clientWidth;
	const observer = new ResizeObserver(() => {
		if (viewport && previousWidth !== viewport.clientWidth) {
			previousWidth = viewport.clientWidth;
			if (automaticFit) fit();
		}
	});
	observer.observe(viewport);
	return () => observer.disconnect();
});
function fit() {
	automaticFit = true;
	if (viewport?.clientWidth)
		scale = Math.max(0.35, Math.min(1, (viewport.clientWidth - 36) / Math.max(1, graph.width)));
}
function zoom(delta: number) {
	automaticFit = false;
	scale = Math.max(0.35, Math.min(1.5, scale + delta));
}
function sameTarget(a: HighlightTarget | null, b: HighlightTarget | null) {
	if (!a || !b || a.part !== b.part) return false;
	if (a.part === "edge" || b.part === "edge")
		return a.part === "edge" && b.part === "edge" && a.edgeId === b.edgeId;
	return a.nodeId === b.nodeId;
}
function target(node: WorkflowNode, part: Target["part"] = "turn"): Target {
	return { nodeId: node.id, part };
}
function isPreview(node: WorkflowNode, part: Target["part"] = "turn") {
	return sameTarget(preview, target(node, part));
}
function isSelected(node: WorkflowNode, part: Target["part"] = "turn") {
	return sameTarget(selected, target(node, part));
}
function showPreview(event: MouseEvent | FocusEvent | KeyboardEvent, value: HighlightTarget) {
	const element = event.currentTarget as HTMLElement | SVGGElement;
	// The latest interaction owns the preview; leaving it must not revive an older one.
	preview = { ...value, element };
	positionTooltip();
}
function hidePreview(event: MouseEvent | FocusEvent) {
	if (preview?.element === event.currentTarget) preview = null;
}
function positionTooltip() {
	const value = preview;
	if (!value) return;
	const routeBounds = value.element.getBoundingClientRect();
	const rect = (
		value.part === "edge" ? (value.element.querySelector("text") ?? value.element) : value.element
	).getBoundingClientRect();
	let boundary: Pick<DOMRect, "top" | "bottom"> =
		value.element.closest(".repeat-group")?.getBoundingClientRect() ?? routeBounds;
	if (value.part === "edge") {
		const edge = graph.edges.find((edge) => edge.id === value.edgeId);
		const canvas = value.element.closest(".canvas")?.getBoundingClientRect();
		if (edge && canvas) {
			// Keep the complete route and its endpoint boxes clear of its tooltip.
			const endpoints = graph.nodes.filter((node) => node.id === edge.from || node.id === edge.to);
			boundary = {
				top: Math.min(boundary.top, ...endpoints.map((node) => canvas.top + node.y * scale)),
				bottom: Math.max(
					boundary.bottom,
					...endpoints.map((node) => canvas.top + (node.y + node.height) * scale),
				),
			};
		}
	}
	tooltipPosition = {
		left: Math.max(12, Math.min(innerWidth - 292, rect.left + rect.width / 2 - 140)),
		top:
			boundary.bottom + (tooltip?.offsetHeight ?? 155) + 10 > innerHeight
				? Math.max(12, boundary.top - (tooltip?.offsetHeight ?? 145) - 10)
				: boundary.bottom + 10,
	};
}
async function select(value: Target, element?: HTMLElement) {
	if (element && !element.closest(".step-inspector")) opener = element;
	if (sameTarget(selected, value)) {
		await closeInspector();
		return;
	}
	selected = value;
	await tick();
	if (
		inspector &&
		viewport &&
		inspector.getBoundingClientRect().top >= viewport.getBoundingClientRect().bottom
	) {
		inspector.scrollIntoView?.({ block: "nearest" });
		inspector.focus({ preventScroll: true });
	}
}
async function closeInspector() {
	selected = null;
	preview = null;
	await tick();
	if (opener?.isConnected) opener.focus({ preventScroll: true });
	// Restore keyboard position without reopening the tooltip the user just dismissed.
	preview = null;
}
function onKey(event: KeyboardEvent) {
	if (event.key !== "Escape" || (!selected && !preview)) return;
	event.stopPropagation();
	if (selected) void closeInspector();
	else preview = null;
}
function connected(edge: WorkflowEdge) {
	if (!active) return false;
	if (active.part === "edge") return active.edgeId === edge.id;
	if (active.part === "loop" || active.part === "results") return false;
	const node = graph.nodes.find((node) => node.id === active.nodeId);
	if (node?.repeat && active.part === "collect") return edge.from === node.id;
	if (node?.repeat && active.part === "turn") return edge.to === node.id;
	return edge.from === active.nodeId || edge.to === active.nodeId;
}
function internalActive(node: WorkflowNode, part: "results" | "loop") {
	if (!active || active.part === "edge" || active.nodeId !== node.id) return false;
	if (active.part === "loop" || active.part === "results") return active.part === part;
	return active.part !== "collect" || part === "results";
}
function edgeSummary(edge: WorkflowEdge) {
	return `${graph.nodes.find((node) => node.id === edge.from)?.title} → ${graph.nodes.find((node) => node.id === edge.to)?.title}`;
}
function routeTitle(edge: WorkflowEdge) {
	return edge.condition?.label ?? edge.label;
}
function edgeLabel(edge: WorkflowEdge) {
	const label = routeTitle(edge);
	return `Highlight route: ${label ? `${label}. ` : ""}${edgeSummary(edge)}`;
}
function routeDescribed(value: RouteTarget) {
	return sameTarget(preview, value) ? `${uid}-tooltip` : undefined;
}
function localPoints(node: WorkflowNode, edge: WorkflowEdge, source: boolean): Point[] {
	if (!node.repeat) return [];
	const point = source ? edge.points[0] : edge.points.at(-1);
	if (!point) return [];
	const boundary = { x: point.x - node.x, y: point.y - node.y };
	const side = source ? edge.sourceSide : edge.targetSide;
	const { activity, collector, axis } = node.repeat;
	if (source) {
		if (side === "right")
			return [
				{ x: collector.x + 12, y: axis },
				{ x: collector.x + 28, y: axis },
				{ x: collector.x + 28, y: boundary.y },
				boundary,
			];
		return [
			{ x: collector.x, y: axis + (side === "top" ? -14 : 14) },
			{ x: boundary.x, y: axis + (side === "top" ? -14 : 14) },
			boundary,
		];
	}
	if (side === "left") return [boundary, { x: activity.x, y: boundary.y }];
	return [
		boundary,
		{ x: boundary.x, y: side === "top" ? activity.y : activity.y + activity.height },
	];
}
function title(node: WorkflowNode, part: Target["part"] | "loop" | "results" = "turn") {
	if (part === "loop") return "Next item";
	if (part === "results") return "All items done";
	return part === "collect" ? "Collect results" : part === "repeat" ? "For each item" : node.title;
}
function summary(node: WorkflowNode, part: Target["part"] | "loop" | "results" = "turn") {
	if (part === "loop") return "Repeat the activity for the next item in the collection.";
	if (part === "results") return "Once every item has yielded a result, continue to collection.";
	if (part === "collect")
		return "Combine ordered item results, update state, and choose one route. Runs once, even for an empty collection; this is part of the mapped turn.";
	if (part === "repeat")
		return "Repeat this LLM activity for each frozen item, one at a time. Collect all results before choosing the next route.";
	if (node.repeat)
		return "One LLM activity per item. Its outcome yields an item result; collection chooses the route after all items.";
	if (node.kind === "llm") return "An LLM turn with the tools declared for this step.";
	if (node.kind === "automatic") return "Runs deterministic process code without invoking a model.";
	if (node.kind === "human") return "Waits for an operator decision or a declared external action.";
	if (node.kind === "external") return "Waits for a declared external event.";
	return node.synthetic
		? "The process can be aborted from any active turn. No explicit workflow route is declared."
		: `The process ends as ${node.kind}.`;
}
function iconName(node: WorkflowNode) {
	return node.kind === "completed" ? "complete" : node.kind === "aborted" ? "abort" : node.kind;
}
function box(node: WorkflowNode) {
	return `left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px`;
}
function categoryLabel(tool: ProcessFlowTool, node: WorkflowNode) {
	return {
		workspace: "Workspace",
		integration: "Integration",
		question: "Ask operator",
		outcome: node.repeat ? "Finish item" : "Outcome",
	}[tool.category];
}
function described(node: WorkflowNode, part: Target["part"] = "turn") {
	return tooltipNode?.id === node.id && preview?.part === part ? `${uid}-tooltip` : undefined;
}
</script>

<div class="workflow-graph" role="region" aria-label="Workflow definition" bind:this={root} tabindex="-1" data-section="process-flow-diagram" data-flow-mode="full">
  {#if !graph.nodes.length}<p class="empty">No workflow definition is available.</p>
  {:else}
  <div class="workbench" class:with-inspector={!!chosen && inspectorPlacement === 'auto'}>
    <section class="graph-panel" aria-label="Process flow chart">
      <div class="toolbar"><strong>Process flow</strong><span class="toolbar-hint">Select a step to explore</span><div class="zoom-controls"><button aria-label="Zoom out" disabled={scale <= .35} onclick={() => zoom(-.1)}><Icon name="minus" size={17}/></button><span>{Math.round(scale*100)}%</span><button aria-label="Zoom in" disabled={scale >= 1.5} onclick={() => zoom(.1)}><Icon name="plus" size={17}/></button><button aria-label="Fit graph to viewport" onclick={fit}><Icon name="fit" size={17}/></button></div></div>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to focus and scroll the canvas.) -->
      <div class="graph-viewport" bind:this={viewport} role="region" aria-label="Workflow canvas. Scroll to explore." tabindex="0">
        <div class="graph-size" style={`width:${graph.width*scale}px;height:${graph.height*scale}px`}>
          <div class="canvas" style={`width:${graph.width}px;height:${graph.height}px;transform:scale(${scale});--graph-route-hit-width:${14/scale}px`}>
            <svg class="edges" width={graph.width} height={graph.height} role="group" aria-label="Workflow transitions">
              <defs>{#each ['normal','active','loop'] as kind}<marker id={`${uid}-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke={kind === 'loop' ? 'var(--graph-amber)' : kind === 'active' ? 'var(--graph-accent)' : 'var(--graph-route)'} stroke-width="1.7"/></marker>{/each}</defs>
              {#each graph.edges as edge (edge.id)}
                {@const routeTarget = { part: 'edge', edgeId: edge.id } as const}
                {@const label = routeTitle(edge)}
                <Route id={edge.id} section="outer" path={edgePath(edge.points)} active={connected(edge)} muted={!!active && !connected(edge)} rework={edge.kind === 'loopback'} markerPrefix={uid} arrowEnd={!graph.nodes.find(node => node.id === edge.to)?.repeat}
                  label={label ? [label] : []} labelPosition={edge.labelPosition} accessibleLabel={edgeLabel(edge)} describedBy={routeDescribed(routeTarget)}
                  from={graph.nodes.find(node => node.id === edge.from)?.turnId ?? undefined} to={graph.nodes.find(node => node.id === edge.to)?.turnId ?? undefined} kind={edge.kind}
                  onPreview={event => showPreview(event, routeTarget)} onExit={hidePreview}/>
              {/each}
            </svg>
            {#each graph.nodes as node (node.id)}
              {#if node.repeat}
                {@const geometry=node.repeat}
                <div class="repeat-group" style={box(node)} role="group" aria-label={`${node.title}: one repeated LLM turn`}>
                  <button class="repeat-node" class:highlighted={isPreview(node,'repeat')} class:chosen={isSelected(node,'repeat')} data-flow-turn-id={node.turnId} data-part="repeat" aria-label={`Repeat ${node.title}, one item at a time`} aria-expanded={isSelected(node,'repeat')} aria-describedby={described(node,'repeat')} onclick={event => select(target(node,'repeat'),event.currentTarget)} onmouseenter={event=>showPreview(event,target(node,'repeat'))} onmouseleave={hidePreview} onfocus={event=>showPreview(event,target(node,'repeat'))} onblur={hidePreview}><span class="repeat-title"><Icon name="map" size={18}/>For each item</span>{#if isSelected(node,'repeat')}<span class="selected-dot"></span>{/if}</button>
                  <svg class="internal-paths" width={node.width} height={node.height} role="group" aria-label={`Routes within ${node.title}`}>
                    {#each graph.edges.filter(edge=>edge.from === node.id || edge.to === node.id) as edge (edge.id)}
                      {#each [true,false].filter(source => source ? edge.from === node.id : edge.to === node.id) as source}
                        {@const routeTarget = { part: 'edge', edgeId: edge.id } as const}
                        <Route id={edge.id} section={source?'exit':'entry'} path={edgePath(localPoints(node,edge,source))} active={connected(edge)} muted={!!active && !connected(edge)} rework={edge.kind === 'loopback'} markerPrefix={uid} arrowEnd={!source} tabbable={false}
                          accessibleLabel={edgeLabel(edge)} describedBy={routeDescribed(routeTarget)} onPreview={event => showPreview(event, routeTarget)} onExit={hidePreview}/>
                      {/each}
                    {/each}
                    <Route id={`${node.id}:results`} section="results" path={`M253 ${geometry.axis}H312`} active={internalActive(node,'results')} muted={!!active && !internalActive(node,'results')} markerPrefix={uid}
                      label={['All items','done']} labelPosition={{x:282,y:geometry.axis-22}} repeatLabel accessibleLabel={`Highlight all items done: ${node.title} to Collect results`} describedBy={routeDescribed({nodeId:node.id,part:'results'})}
                      onPreview={event => showPreview(event,{nodeId:node.id,part:'results'})} onExit={hidePreview}/>
                    <Route id={`${node.id}:loop`} section="loop" path={`M253 ${geometry.axis}H268V${geometry.loopY}H65V${geometry.activity.y+geometry.activity.height}`} active={internalActive(node,'loop')} muted={!!active && !internalActive(node,'loop')} markerPrefix={uid}
                      label={['Next item']} labelPosition={{x:167,y:geometry.loopY}} repeatLabel accessibleLabel={`Highlight next item: ${node.title}`} describedBy={routeDescribed({nodeId:node.id,part:'loop'})}
                      onPreview={event => showPreview(event,{nodeId:node.id,part:'loop'})} onExit={hidePreview}/>
                  </svg>
                  <button class="activity" class:highlighted={isPreview(node)} class:chosen={isSelected(node)} style={`left:${geometry.activity.x}px;top:${geometry.activity.y}px;width:${geometry.activity.width}px;height:${geometry.activity.height}px`} data-flow-turn-id={node.turnId} data-part="turn" aria-label={`${node.title}. LLM activity for one item.`} aria-expanded={isSelected(node)} aria-describedby={described(node)} onclick={event=>select(target(node),event.currentTarget)} onmouseenter={event=>showPreview(event,target(node))} onmouseleave={hidePreview} onfocus={event=>showPreview(event,target(node))} onblur={hidePreview}>
                    <span class="kind-icon llm"><Icon name="llm" size={20}/></span><span class="node-content"><span class="node-kind">LLM turn</span><strong>{node.title}</strong>{#if node.definition?.tools}<span class="tool-count"><Icon name="wrench" size={11}/>{node.definition.tools.length}{node.definition.hasDynamicTools?'+':''} {node.definition.tools.length===1&&!node.definition.hasDynamicTools?'tool':'tools'}</span>{/if}</span>{#if isSelected(node)}<span class="selected-dot"></span>{/if}
                  </button>
                  <button class="collector" style={`left:${geometry.collector.x-22}px;top:${geometry.axis-30}px`} class:highlighted={isPreview(node,'collect')} class:chosen={isSelected(node,'collect')} data-flow-turn-id={node.turnId} data-part="collect" aria-label={`Collect results for ${node.title}`} aria-expanded={isSelected(node,'collect')} aria-describedby={described(node,'collect')} onclick={event=>select(target(node,'collect'),event.currentTarget)} onmouseenter={event=>showPreview(event,target(node,'collect'))} onmouseleave={hidePreview} onfocus={event=>showPreview(event,target(node,'collect'))} onblur={hidePreview}><Icon name="collect" size={28}/><span>Collect results</span></button>
                </div>
              {:else}
                <button class="flow-node {node.kind}" class:highlighted={isPreview(node)} class:chosen={isSelected(node)} style={box(node)} data-flow-turn-id={node.turnId ?? undefined} data-flow-end-state={!node.turnId?node.kind:undefined} data-part="turn" aria-label={`${node.title}. ${turnKindLabel(node.kind)}`} aria-expanded={isSelected(node)} aria-describedby={described(node)} onclick={event=>select(target(node),event.currentTarget)} onmouseenter={event=>showPreview(event,target(node))} onmouseleave={hidePreview} onfocus={event=>showPreview(event,target(node))} onblur={hidePreview}>
                  <span class="kind-icon {node.kind}"><Icon name={iconName(node)} size={20}/></span><span class="node-content">{#if node.turnId}<span class="node-kind">{turnKindLabel(node.kind)}</span>{/if}<strong>{node.title}</strong>{#if node.kind === 'llm' && node.definition?.tools}<span class="tool-count"><Icon name="wrench" size={11}/>{node.definition.tools.length}{node.definition.hasDynamicTools?'+':''} {node.definition.tools.length===1&&!node.definition.hasDynamicTools?'tool':'tools'}</span>{/if}{#if node.synthetic}<span class="synthetic-caption">From any active turn</span>{/if}</span>{#if isSelected(node)}<span class="selected-dot"></span>{/if}
                </button>
              {/if}
            {/each}
          </div>
        </div>
      </div>
      <div class="graph-footer"><div class="legend">{#each presentKinds as kind}<span><Icon name={kind} size={14}/>{turnKindLabel(kind)}</span>{/each}{#if graph.nodes.some(node=>node.repeat)}<span><Icon name="collect" size={14}/>Collection</span>{/if}<span><i></i>Transition</span>{#if graph.edges.some(edge=>edge.kind==='loopback')}<span><i class="loop"></i>Rework route</span>{/if}</div></div>
    </section>
    {#if chosen && selected}
      <section class="step-inspector" bind:this={inspector} tabindex="-1" aria-label={`Details for ${title(chosen,selected.part)}`}>
        <div class="inspector-heading"><span class="kind-icon {chosen.kind}"><Icon name={selected.part==='collect'?'collect':selected.part==='repeat'?'map':iconName(chosen)} size={22}/></span><h3>{title(chosen,selected.part)}</h3><button aria-label="Close step details" onclick={closeInspector}><Icon name="close" size={20}/></button></div>
        <p>{summary(chosen,selected.part)}</p>
        {#if chosen.turnId}<button class="author-toggle" aria-pressed={authorDetails} onclick={()=>authorDetails=!authorDetails}><Icon name="edit" size={14}/>Author details</button>{/if}
        {#if authorDetails && chosen.definition}<dl class="author-details"><dt>Turn</dt><dd><code>{chosen.turnId}</code></dd><dt>Declared inputs</dt><dd>{chosen.definition.inputProducts?.join(', ') || 'No named products declared'}</dd><dt>Published products</dt><dd>{chosen.definition.outputProducts?.join(', ') || 'No named products declared'}</dd></dl>{/if}
        {#if chosen.kind==='llm' && selected.part!=='collect'}<section class="available-tools"><h4><Icon name="wrench" size={15}/>Available tools</h4>{#key chosen.id}<ul>{#each chosen.definition?.tools ?? [] as tool (tool.name)}<li><details class="tool-disclosure"><summary><code>{tool.name}</code><Icon name="right" size={14}/></summary><div class="tool-body"><span>{categoryLabel(tool,chosen)}</span>{#if tool.description}<p>{tool.description}</p>{/if}</div></details></li>{:else}<li class="muted">{chosen.definition?.tools ? 'No static tools declared.' : 'Tool declarations are unavailable.'}</li>{/each}</ul>{/key}{#if chosen.definition?.hasDynamicTools}<p class="muted dynamic-tools">Additional integration tools are determined when this turn starts.</p>{/if}</section>{/if}
        <section class="outgoing"><h4>{chosen.repeat?'After collection':chosen.turnId?'Possible transitions':'End of this workflow'}</h4>{#each routes as route (route.id)}{@const destination=graph.nodes.find(node=>node.id===route.to)}{#if destination}<button class="route-option" class:rework={route.kind==='loopback'} onclick={()=>select(target(destination))}><Icon name={route.kind==='loopback'?'loop':'arrow'} size={18}/><span>{#if routeTitle(route)}<strong>{routeTitle(route)}</strong>{/if}<span>{destination.title}</span>{#if route.condition?.description}<span>{route.condition.description}</span>{/if}</span><Icon name="right" size={14}/></button>{/if}{:else}<p class="muted">{chosen.turnId?'No static transitions declared.':'No outgoing transitions.'}</p>{/each}</section>
        {#if onInspectTurn && chosen.turnId}<button class="inspect-turn" onclick={()=>onInspectTurn?.(chosen.turnId as string)}>Open turn details<Icon name="right" size={15}/></button>{/if}
      </section>
    {/if}
  </div>
  {/if}
  {#if tooltipNode && preview && preview.part !== 'edge'}<div bind:this={tooltip} id={`${uid}-tooltip`} class="node-tooltip" role="tooltip" style={`left:${tooltipPosition.left}px;top:${tooltipPosition.top}px`}><strong>{title(tooltipNode,preview.part)}</strong><p>{summary(tooltipNode,preview.part)}</p>{#if preview.part !== 'loop' && preview.part !== 'results'}<span>Click to explore</span>{/if}</div>
  {:else if tooltipEdge}<div bind:this={tooltip} id={`${uid}-tooltip`} class="node-tooltip" role="tooltip" style={`left:${tooltipPosition.left}px;top:${tooltipPosition.top}px`}><strong>{routeTitle(tooltipEdge) || 'Transition'}</strong><p>{edgeSummary(tooltipEdge)}</p>{#if tooltipEdge.condition}{#if tooltipEdge.label && tooltipEdge.label !== tooltipEdge.condition.label}<p>After {tooltipEdge.label}</p>{/if}{#if tooltipEdge.condition.description}<p>{tooltipEdge.condition.description}</p>{/if}{/if}</div>{/if}
</div>

<style>
.workflow-graph {--graph-accent:var(--chronicle-accent,#2f61b7);--graph-paper:var(--chronicle-panel,#fff);--graph-ink:var(--chronicle-text,#18212b);--graph-muted:var(--chronicle-text-muted,#5c6a7b);--graph-line:var(--chronicle-border,#d8e0ea);--graph-route:#9eacbd;--graph-amber:var(--chronicle-warning,#a76b17);--graph-tint:color-mix(in srgb,var(--graph-accent) 4%,var(--graph-paper));color:var(--graph-ink);font-family:inherit;container-type:inline-size;min-width:0;width:100%;}
.workflow-graph * {box-sizing:border-box;}
button {font:inherit;color:inherit;background:none;border:0;cursor:pointer;} button:disabled{opacity:.4;cursor:default;} button:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid color-mix(in srgb,var(--graph-accent) 65%,white);outline-offset:3px;} svg{flex:none;vertical-align:middle;} p,h3,h4,dl,dd{margin:0;} .workbench{display:grid;gap:18px;align-items:start;min-width:0;}
.graph-panel{min-width:0;background:var(--graph-paper);border:1px solid var(--graph-line);border-radius:14px;overflow:hidden;}
.toolbar{display:flex;align-items:center;gap:18px;min-height:55px;padding:10px 16px;border-bottom:1px solid var(--graph-line);font-size:12px;} .toolbar strong{font-weight:600;} .toolbar-hint{font-size:11px;color:var(--graph-muted);} .zoom-controls{display:flex;align-items:center;gap:5px;margin-left:auto;} .zoom-controls button{display:grid;place-items:center;width:30px;height:30px;border-radius:5px;} .zoom-controls button:hover{background:var(--graph-tint);} .zoom-controls>span{min-width:36px;text-align:center;font-size:11px;font-variant-numeric:tabular-nums;color:var(--graph-muted);}
.graph-viewport{overflow:auto;padding:16px;min-height:350px;max-height:700px;background-color:var(--graph-paper);background-image:radial-gradient(color-mix(in srgb,var(--graph-line) 90%,transparent) .8px,transparent .8px);background-size:20px 20px;display:flex;align-items:center;justify-content:safe center;}
.graph-size{flex:none;position:relative;}.canvas{position:absolute;inset:0;transform-origin:top left;}.edges{position:absolute;inset:0;pointer-events:none;overflow:visible;}
.flow-node,.activity{position:absolute;display:flex;align-items:center;gap:11px;padding:17px;background:var(--graph-paper);border:1px solid var(--graph-line);border-radius:12px;text-align:left;}.flow-node.highlighted,.activity.highlighted{background:color-mix(in srgb,var(--graph-accent) 8%,var(--graph-paper));border-color:color-mix(in srgb,var(--graph-accent) 65%,var(--graph-line));}.flow-node.chosen,.activity.chosen{border-color:var(--graph-accent);background:var(--graph-tint);}.node-content{display:flex;flex-direction:column;gap:4px;min-width:0;}.node-content strong{font-size:15px;font-weight:600;line-height:1.4;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}.node-kind{font-size:9px;line-height:1.5;font-weight:650;letter-spacing:.65px;text-transform:uppercase;color:var(--graph-muted);}.kind-icon{width:33px;height:33px;display:grid;place-items:center;flex:none;border-radius:50%;background:color-mix(in srgb,var(--graph-muted) 7%,var(--graph-paper));color:var(--graph-muted);}.kind-icon.llm{color:var(--graph-accent);background:color-mix(in srgb,var(--graph-accent) 8%,var(--graph-paper));}.tool-count{display:flex;gap:5px;align-items:center;color:var(--graph-muted);font-size:9px;line-height:1.4;}.completed{color:#257651;background:color-mix(in srgb,#257651 5%,var(--graph-paper));}.aborted{color:var(--graph-muted);background:color-mix(in srgb,var(--graph-muted) 5%,var(--graph-paper));}.synthetic-caption{font-size:10px;}.selected-dot{position:absolute;width:6px;height:6px;border-radius:50%;background:var(--graph-accent);right:10px;top:11px;}
.repeat-group{position:absolute;}.repeat-node{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;border-radius:12px;background:var(--graph-tint);text-align:left;}.repeat-node::before{content:"";position:absolute;inset:0;border:1px dashed color-mix(in srgb,var(--graph-accent) 30%,var(--graph-line));border-radius:inherit;pointer-events:none;}.repeat-node.highlighted::before{border-color:var(--graph-accent);}.repeat-node.chosen::before{border:2px dashed var(--graph-accent);}.repeat-title{position:absolute;left:20px;top:20px;display:flex;gap:8px;align-items:center;font-size:12px;font-weight:600;color:var(--graph-accent);}.activity{padding:13px;border-radius:9px;}.internal-paths{position:absolute;inset:0;pointer-events:none;}
.collector{position:absolute;width:44px;height:100px;display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 4px;color:var(--graph-muted);}.collector>span{font-size:10px;line-height:1.4;text-align:center;}.collector.highlighted,.collector.chosen{--collection-fill:color-mix(in srgb,var(--graph-accent) 15%,var(--graph-paper));color:var(--graph-accent);}.collector.highlighted :global(svg),.collector.chosen :global(svg){stroke-width:2.2px;}.collector.chosen>span{font-weight:650;}.collector:focus-visible{outline:none;}.collector:focus-visible>span{outline:2px solid var(--graph-accent);outline-offset:4px;border-radius:2px;}
.graph-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-top:1px solid var(--graph-line);font-size:10px;color:var(--graph-muted);}.legend{display:flex;flex-wrap:wrap;gap:12px 18px;}.legend>span{display:flex;gap:6px;align-items:center;}.legend i{width:18px;border-top:1.6px solid var(--graph-route);}.legend i.loop{border-color:var(--graph-amber);}
.step-inspector{min-width:0;border:1px solid var(--graph-line);border-radius:12px;background:var(--graph-paper);padding:18px;font-size:12px;line-height:1.7;display:grid;gap:18px;overflow-wrap:anywhere;}.inspector-heading{display:flex;align-items:center;gap:10px;}.inspector-heading h3{font-size:15px;line-height:1.4;flex:1;}.inspector-heading button{display:grid;place-items:center;width:30px;height:30px;border-radius:5px;}.inspector-heading button:hover{background:var(--graph-tint);}.step-inspector>p{color:var(--graph-muted);max-width:65ch;}.author-toggle{justify-self:start;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--graph-muted);padding:5px 0;}.author-toggle[aria-pressed="true"]{color:var(--graph-accent);}.author-details{display:grid;grid-template-columns:100px minmax(0,1fr);gap:10px;font-size:11px;}.author-details dt{color:var(--graph-muted);}.available-tools,.outgoing{padding-top:16px;border-top:1px solid var(--graph-line);}.available-tools h4,.outgoing h4{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;}.available-tools ul{list-style:none;padding:0;margin:10px 0 0;}.available-tools li+li{border-top:1px solid var(--graph-line);}.tool-disclosure summary{display:flex;gap:12px;align-items:center;justify-content:space-between;cursor:pointer;padding:12px 0;list-style:none;}.tool-disclosure summary::-webkit-details-marker{display:none;}.tool-disclosure code{font-size:11px;overflow-wrap:anywhere;}.tool-disclosure summary :global(svg){flex:none;transition:transform .15s;}.tool-disclosure[open] summary :global(svg){transform:rotate(90deg);}.tool-disclosure summary:hover{color:var(--graph-accent);}.tool-body{padding:0 0 13px;color:var(--graph-muted);font-size:11px;}.tool-body>span{display:block;font-weight:600;margin-bottom:4px;}.dynamic-tools{font-size:11px;margin-top:12px;}.muted{color:var(--graph-muted);}.route-option{width:100%;display:flex;gap:10px;align-items:center;padding:12px 0;text-align:left;border-bottom:1px solid var(--graph-line);color:var(--graph-accent);font-size:11px;}.route-option>span{display:grid;gap:3px;flex:1;}.route-option strong{font-weight:600;color:var(--graph-ink);}.route-option.rework{color:var(--graph-amber);}.route-option:hover{background:var(--graph-tint);}.inspect-turn{display:flex;align-items:center;justify-content:space-between;padding:8px 0;color:var(--graph-accent);font-size:12px;}.empty{padding:16px;color:var(--graph-muted);font-size:13px;}
.node-tooltip{position:fixed;width:280px;max-width:calc(100vw - 24px);z-index:1000;pointer-events:none;background:#21364f;color:white;padding:15px 17px;border-radius:10px;box-shadow:0 6px 25px #182b452e;font-size:11px;line-height:1.7;}.node-tooltip strong{font-size:12px;}.node-tooltip p{margin-top:7px;color:#e4edfa;}.node-tooltip>span{display:block;margin-top:9px;color:#cbdaf1;font-size:10px;}
@container(min-width:1100px){.workbench.with-inspector{grid-template-columns:minmax(0,1fr) 330px;}}
@container(max-width:650px){.toolbar-hint{display:none;}.toolbar{gap:8px;padding:10px;}.graph-viewport{justify-content:flex-start;max-height:550px;}.graph-footer{padding:12px;}.legend{gap:10px;}.author-details{grid-template-columns:1fr;gap:4px;}.author-details dd{margin-bottom:8px;}}
@media(prefers-reduced-motion:reduce){.tool-disclosure summary :global(svg){transition:none;}}
</style>

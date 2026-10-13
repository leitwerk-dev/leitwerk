<script lang="ts">
import { shortestSuccessfulPath } from "@leitwerk-dev/workflow-graph";
import WorkflowGraph from "@leitwerk-dev/workflow-graph/WorkflowGraph.svelte";
import type { ProcessFlowView, UiLauncherSummary } from "../lib/api.js";

let {
	launcher,
	flow,
	mode = "happy",
	compact = false,
	expandable = false,
	onSelectTurn,
}: {
	launcher?: UiLauncherSummary;
	flow?: ProcessFlowView;
	mode?: "happy" | "full";
	compact?: boolean;
	expandable?: boolean;
	onSelectTurn?: (turnId: string) => void;
} = $props();
const id = $props.id();
let expanded = $state(false);
const view = $derived(flow ?? launcher?.processFlow);
const spine = $derived(
	view
		? shortestSuccessfulPath(view).flatMap(
				(id) => view.nodes.find((node) => node.turnId === id) ?? [],
			)
		: [],
);
const completes = $derived(
	view?.edges.some(
		(edge) => edge.from === spine.at(-1)?.turnId && edge.lifecycleStatus === "completed",
	),
);
</script>
{#if view && view.nodes.length}
  <div class="flow-disclosure" data-section={expandable?'process-flow-disclosure':undefined}>
    {#if mode==='full' || expanded}<div id={id}><WorkflowGraph flow={view} onInspectTurn={onSelectTurn}/></div>
    {:else}
      <ol class="process-flow" class:is-compact={compact} data-section="process-flow-diagram" data-flow-mode="happy" aria-label="Shortest successful path">
        {#each spine as node,index (node.turnId)}<li class="flow-step" data-flow-turn-id={node.turnId}>{#if index}<span aria-hidden="true">→</span>{/if}<span class="step-chip" data-turn-type={node.turnType}>{node.description}{#if node.repetition}<small>For each item</small>{/if}</span></li>{/each}
        {#if completes}<li class="flow-step" data-flow-end-state="completed"><span aria-hidden="true">→</span><span class="end-chip">Completed</span></li>{/if}
      </ol>
    {/if}
    {#if expandable}<button class="flow-toggle" data-pressable="true" aria-expanded={expanded} aria-controls={id} onclick={()=>expanded=!expanded}>{expanded?'Hide flow':'Show full flow'}</button>{/if}
  </div>
{/if}
<style>
.flow-disclosure{min-width:0;display:grid;gap:10px;}.process-flow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;list-style:none;padding:0;margin:0;}.flow-step{display:flex;align-items:center;gap:8px;min-width:0;color:var(--chronicle-text-muted);font-size:12px;}.step-chip,.end-chip{background:var(--chronicle-panel-muted);border:1px solid var(--chronicle-border);border-radius:6px;padding:5px 8px;overflow-wrap:anywhere;color:var(--chronicle-text);}.end-chip{color:var(--chronicle-success,#257651);}.step-chip small{display:block;font-size:10px;color:var(--chronicle-text-muted);}.is-compact .flow-step{font-size:11px;}.is-compact .step-chip,.is-compact .end-chip{padding:3px 6px;}.flow-toggle{justify-self:start;font:inherit;font-size:12px;border:0;background:transparent;color:var(--chronicle-accent);cursor:pointer;padding:5px 0;}.flow-toggle:hover{text-decoration:underline;text-underline-offset:3px;}.flow-toggle:focus-visible{outline:2px solid var(--chronicle-accent);outline-offset:3px;}
</style>

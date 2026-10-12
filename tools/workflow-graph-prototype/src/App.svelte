<script>
import WorkflowGraph from "@leitwerk-dev/workflow-graph/WorkflowGraph.svelte";
import { flows, flowView } from "./flows.js";
import Icon from "./Icon.svelte";

const params = new URLSearchParams(location.search);
const initialFlow = flows.find((flow) => flow.id === params.get("flow")) ?? flows[0];
let flowId = $state(initialFlow.id);
let variant = $state(params.get("variant") === "guided" ? "guided" : "loop");
const flow = $derived(flows.find((flow) => flow.id === flowId));
const view = $derived(flowView(flow));
let startName = $state(initialFlow.startValue);
let brief = $state(initialFlow.startBrief);
let previewReady = $state(false);
$effect(() => {
	const url = new URL(location.href);
	url.searchParams.set("flow", flowId);
	url.searchParams.set("variant", variant);
	history.replaceState(null, "", url);
});
function chooseFlow(sample) {
	flowId = sample.id;
	startName = sample.startValue;
	brief = sample.startBrief;
	previewReady = false;
}
</script>
<div class="app-shell">
  <header class="site-header"><a class="brand" href="?variant=loop&flow=release" aria-label="Leitwerk workflow lab"><span class="brand-mark"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 4v15h14M10 4v10h9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>leitwerk<span class="brand-divider"></span><span class="lab-name">Workflow lab</span></a><div class="header-meta"><span class="experimental">Preview</span><span class="synthetic-note">Synthetic examples only</span></div></header>
  <main>
    <nav class="sample-tabs" aria-label="Synthetic workflow samples">{#each flows as sample}<button class:active={flowId===sample.id} aria-pressed={flowId===sample.id} onclick={()=>chooseFlow(sample)}>{sample.name}</button>{/each}<span>Shared with the application UI</span></nav>
    <div class="page-intro"><div><h1>{flow.name}</h1><p>{flow.description}</p></div><div class="view-actions"><span><Icon name={variant==='guided'?'play':'branch'} size={18}/>{variant==='guided'?'Guided preview':'Repeat path'}</span><button onclick={()=>variant=variant==='guided'?'loop':'guided'}><Icon name={variant==='guided'?'branch':'play'} size={15}/>{variant==='guided'?'Back to graph':'Start preview'}</button></div></div>
    {#if variant==='guided'}
      <section class="guided-layout" aria-label="Before you start"><div class="journey"><h2>Shortest successful path</h2><p>Conditional routes stay available along the way.</p>{#each view.spine as id}{@const node=flow.nodes.find(node=>node.id===id)}<article class="journey-step"><span class="journey-icon"><Icon name={node.kind==='map'?'llm':node.kind} size={22}/></span><div><h3>{node.title}</h3>{#if node.kind==='map'}<p><Icon name="map" size={15}/>For each item · one at a time</p><p><Icon name="collect" size={15}/>Collect results · route once</p>{:else}<p>{node.summary}</p>{/if}{#if node.tools.length}<span class="tools-note"><Icon name="wrench" size={12}/>{node.tools.length} tools</span>{/if}</div></article>{/each}{#if view.edges.some(edge=>edge.from===view.spine.at(-1)&&edge.lifecycleStatus==='completed')}<article class="journey-step"><span class="journey-icon complete"><Icon name="complete" size={22}/></span><h3>Completed</h3></article>{/if}<button class="text-button" onclick={()=>variant='loop'}>Explore all routes<Icon name="right" size={16}/></button></div>
        <aside class="start-preview"><h2>Starting context</h2><p>Try the starting context for this synthetic workflow.</p><form onsubmit={event=>{event.preventDefault();previewReady=true;}}><label for="start-name">{flow.startLabel}</label><input id="start-name" required bind:value={startName} oninput={()=>previewReady=false}/><label for="start-brief">{flow.id==='intake'?'Request description':'Brief'}</label><textarea id="start-brief" rows="4" required bind:value={brief} oninput={()=>previewReady=false}></textarea><button class="primary-button" type="submit"><Icon name="play" size={18}/>Preview this workflow</button><p class="preview-disclaimer">Preview only. This does not start a process.</p></form>{#if previewReady}<div class="preview-result" role="status"><Icon name="complete" size={19}/><div><strong>Your preview is ready.</strong><p>“{startName}” follows the path shown here. No process was created.</p></div></div>{/if}</aside>
      </section>
    {:else}{#key flowId}<WorkflowGraph flow={view} inspectorPlacement="below"/>{/key}{/if}
    <p class="lab-footer">Leitwerk workflow graph preview. All workflows, conditions, and data on this page are synthetic.</p>
  </main>
</div>

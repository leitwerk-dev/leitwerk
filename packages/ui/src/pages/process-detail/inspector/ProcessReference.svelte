<script lang="ts">
import { tick } from "svelte";
import ChronicleMarkdown from "../../../chronicle/components/ChronicleMarkdown.svelte";
import ChronicleUsageStats from "../../../chronicle/components/ChronicleUsageStats.svelte";
import ConversationTreeDiagram from "../../../components/ConversationTreeDiagram.svelte";
import ExternalLink from "../../../components/ExternalLink.svelte";
import type { ProcessDetailData } from "../../../lib/api.js";
import { buildInspectorPath, type InspectorTarget } from "../../../lib/router-logic.js";
import ProcessFlowDiagram from "../../ProcessFlowDiagram.svelte";
import InspectionEvidence from "./InspectionEvidence.svelte";

let {
	detail,
	target,
	onNavigate,
	onChronicle,
	onShowSummary,
}: {
	detail: ProcessDetailData;
	target: Extract<InspectorTarget, { scope: "process" | "step" }>;
	onNavigate: (target: InspectorTarget) => void;
	onChronicle: (target?: { turnRecordId?: string; turnId?: string }) => void;
	onShowSummary?: () => void;
} = $props();
const node = $derived(
	target.scope === "step"
		? detail.processFlow.nodes.find((node) => node.turnId === target.turnId)
		: null,
);
const definition = $derived(detail.runDetails.turns.find((turn) => turn.turnId === node?.turnId));
const model = $derived(
	detail.modelConfiguration.turns.find((turn) => turn.turnId === node?.turnId),
);
const transitions = $derived(detail.processFlow.edges.filter((edge) => edge.from === node?.turnId));
const usage = $derived(detail.usageEstimate);
const resources = $derived(
	detail.timeline.turns.flatMap((turn) =>
		(turn.resources ?? []).map((link) => ({ ...link, turnRecordId: turn.id })),
	),
);
const request = $derived(detail.timeline.prompt.text);
const parameters = $derived(
	detail.launchConfiguration.parameters.filter((parameter) => parameter.value !== request),
);
const source = $derived(
	detail.process.externalId ?? detail.launchConfiguration.launcherLabel ?? "Source",
);
let contextView = $state<"map" | "list">("map");
let contextList = $state<HTMLUListElement>();
$effect(() => {
	const list = contextList;
	const selected = target.scope === "process" ? target.turnRecordId : undefined;
	if (!list || !selected) return;
	let cancelled = false;
	void tick().then(() => {
		if (cancelled) return;
		const item = list.querySelector<HTMLElement>(".selected");
		if (item) list.scrollTop = item.offsetTop - (list.clientHeight - item.clientHeight) / 2;
	});
	return () => {
		cancelled = true;
	};
});
function selectStep(turnId: string) {
	onNavigate({ scope: "step", turnId });
}
function selectExecution(turnRecordId: string) {
	onNavigate({ scope: "execution", turnRecordId, section: "context" });
}
function sourceLabel(source: string) {
	return (
		(
			{
				instance: "Saved instance override",
				process_config: "Current process configuration",
				catalog_default: "Current catalog default",
				default: "Default model policy",
				none: "Not configured",
			} as Record<string, string>
		)[source] ?? source
	);
}
</script>
<div class="process-reference" class:process-overview={target.scope === "process" && target.section === "overview"} class:context-map={target.scope === "process" && target.section === "context-map"}>
  {#if target.scope === "step"}
    {#if !node}<p class="notice" role="status">This step is unavailable in the current workflow. Its recorded executions remain in the chronicle.</p>
    {:else}
      <p class="reference-note">Current workflow definition · {node.turnType} step</p>
      <section><h2>Purpose</h2><p>{node.description}</p><code>{node.turnId}</code></section>
      <button class="ui-button" onclick={() => onChronicle({turnId:node.turnId})}>Reveal matching executions in chronicle</button>
      <section><h2>Input and output contracts</h2>
        {#if definition}<dl><div><dt>Declared inputs</dt><dd>{(definition.consumedProducts ?? []).join(", ") || "No named products declared"}</dd></div><div><dt>Published products</dt><dd>{(definition.publishedProducts ?? []).join(", ") || "No named products declared"}</dd></div></dl><p class="note">Declarations describe possible inputs. Execution Context shows which versions were actually supplied.</p>
          {#if definition.definitionContract}<InspectionEvidence label="Current step contract" evidence={{state:"recorded", value:definition.definitionContract}} />{/if}
          {#each definition.outcomeActions as outcome (outcome.name)}<InspectionEvidence label={`${outcome.name} · ${outcome.description}`} evidence={{state:"recorded", value:outcome.parameters}} id={`contract:${node.turnId}:${outcome.name}`} />{/each}
        {:else}<p class="note">No inspectable input or output schema is exposed by this definition.</p>{/if}
      </section>
      {#if node.turnType === "llm"}
        <section><h2>Current model policy</h2><p>{model?.effectiveConfiguredModelProfileId ?? detail.modelConfiguration.defaultModel.effectiveModelProfileId ?? "No configured model"}</p><p class="note">{sourceLabel(model?.source ?? detail.modelConfiguration.defaultModel.source)}</p></section>
        <section><h2>Available tools</h2><p>{[...(definition?.activePiToolNames ?? []), ...(definition?.integrationToolNames ?? [])].join(", ") || "No built-in tools declared"}</p><p class="note">These are current declarations. Recorded tool definitions are in each execution’s Configuration.</p></section>
        <section><h2>Current instructions reference</h2><InspectionEvidence label="Current system prompt setting" evidence={detail.runDetails.systemPrompt === null ? {state:"not_recorded", reason:"No process-level system prompt override is configured. This does not describe the effective prompt of a past execution."} : {state:"recorded", value:detail.runDetails.systemPrompt}} /><InspectionEvidence label="Current appended instructions setting" evidence={{state:"recorded", value:detail.runDetails.appendSystemPrompt ?? ""}} /></section>
      {:else}<p class="note">This {node.turnType} step does not invoke a model.</p>{/if}
      <section><h2>Possible transitions</h2><ul class="transition-list">{#each transitions as edge}<li><span>{edge.label ?? edge.kind}</span>{#if edge.to}<button class="text-link" onclick={() => selectStep(edge.to ?? "")}>{detail.processFlow.nodes.find(node => node.turnId === edge.to)?.description ?? edge.to}</button>{:else}<span>{edge.lifecycleStatus}</span>{/if}</li>{:else}<li>No static transitions declared.</li>{/each}</ul></section>
    {/if}
  {:else if target.section === "overview"}
    <section><h2>Run overview</h2><dl class="fact-grid"><div><dt>Status</dt><dd>{detail.process.lifecycleStatus}</dd></div><div><dt>Process</dt><dd>{detail.processDisplayName ?? detail.process.processId}</dd></div><div><dt>Created</dt><dd><time datetime={detail.process.createdAt}>{new Date(detail.process.createdAt).toLocaleString()}</time></dd></div><div><dt>Last updated</dt><dd><time datetime={detail.process.updatedAt}>{new Date(detail.process.updatedAt).toLocaleString()}</time></dd></div><div><dt>Run ID</dt><dd><code>{detail.process.id}</code></dd></div><div><dt>Source</dt><dd>{#if detail.process.externalUrl}<ExternalLink href={detail.process.externalUrl} label={source} />{:else}{detail.process.externalId ?? detail.launchConfiguration.launcherLabel ?? "Not recorded"}{/if}</dd></div></dl>
      {#if onShowSummary}<button class="ui-button" onclick={onShowSummary}>Show process summary</button>{/if}
    </section>
    <section><h2>Usage and cost</h2>{#if usage}<ChronicleUsageStats usage={usage.usage} size="md" /><p class="note">{usage.coveredTurnCount}/{usage.totalLlmTurnCount} model executions with usage · {usage.missingUsageTurnCount} missing usage · {usage.missingCostTurnCount} missing cost{usage.isPartial ? " · Partial totals" : ""}</p>{:else}<p class="note">No usage recorded.</p>{/if}</section>
    {#if detail.launchConfiguration.projects.length}<section><h2>Recorded repositories and branches</h2><p class="note">Repository configuration does not prove a repository was changed.</p>{#each detail.launchConfiguration.projects as project (project.key)}<div class="repository"><div class="repository-identity"><h3>{#if project.externalUrl}<ExternalLink href={project.externalUrl} label={project.key} resourceType="project" />{:else}{project.key}{/if}</h3><p><code>{project.repoLocator}</code></p></div><dl class="repository-branches"><div><dt>Base branch</dt><dd>{project.baseBranch}</dd></div><div><dt>Work branch</dt><dd>{project.workBranch ?? "Not recorded"}</dd></div></dl></div>{/each}</section>{/if}
    <section><h2>Deliverables and evidence</h2>{#if resources.length}<ul class="resource-list">{#each resources as resource (`${resource.turnRecordId}:${resource.id}`)}<li><ExternalLink href={resource.url} label={resource.label} /><button class="text-link" onclick={() => onNavigate({scope:"execution", turnRecordId:resource.turnRecordId, section:"trace"})}>Recorded by execution</button></li>{/each}</ul>{:else}<p class="note">No deliverable links were recorded. Results and decisions remain in the chronicle.</p>{/if}</section>
  {:else if target.section === "workflow"}
    <section><h2>Workflow</h2><p class="reference-note">Current definition · A launch-time graph snapshot was not retained.</p><ProcessFlowDiagram flow={detail.processFlow} mode="full" onSelectTurn={selectStep} />
    <nav class="step-list" aria-label="Workflow steps">{#each detail.processFlow.nodes as step (step.turnId)}<a href={buildInspectorPath(detail.process.id, {scope:"step", turnId:step.turnId})} onclick={event => {if (!event.metaKey && !event.ctrlKey) {event.preventDefault(); selectStep(step.turnId);}}}><span>{step.description}</span><span class="note">{step.turnType}</span></a>{/each}</nav></section>
  {:else if target.section === "inputs"}
    <section><h2>Original request</h2>{#if request}<ChronicleMarkdown markdown={request} /><InspectionEvidence label="Raw original request" evidence={{state:"recorded", value:request}} />{:else}<p class="note">No original request was recorded.</p>{/if}</section>
    <section><h2>Recorded launch parameters</h2>{#if detail.launchConfiguration.paramsParseError}<p class="notice">{detail.launchConfiguration.paramsParseError}</p>{/if}<dl>{#each parameters as parameter (parameter.fieldId)}<div><dt>{parameter.label}</dt><dd>{parameter.value ?? "Not set"}</dd></div>{:else}<div><dd>No additional launch parameters recorded.</dd></div>{/each}</dl><InspectionEvidence label="Raw launch values" evidence={{state:"recorded", value:Object.fromEntries(detail.launchConfiguration.parameters.map(parameter => [parameter.fieldId, parameter.rawValue ?? parameter.value]))}} /></section>
    <section><h2>Model defaults and overrides</h2><dl><div><dt>Default at creation</dt><dd>{detail.process.initialDefaultModelProfileId ?? "Not recorded"}</dd></div><div><dt>Current default</dt><dd>{detail.modelConfiguration.defaultModel.effectiveModelProfileId ?? "Not configured"}</dd></div><div><dt>Current default source</dt><dd>{sourceLabel(detail.modelConfiguration.defaultModel.source)}</dd></div>{#each detail.modelConfiguration.turns as turn (turn.turnId)}<div><dt>{turn.description}</dt><dd>{turn.effectiveConfiguredModelProfileId ?? "Uses the default"}<span class="note"> · {sourceLabel(turn.source)}</span></dd></div>{/each}</dl><p class="note">Mutable settings affect future calls. Inspect an execution for its recorded model and instructions.</p></section>
    <InspectionEvidence label="Launcher and infrastructure details" evidence={{state:"recorded", value:{launcherId:detail.launchConfiguration.launcherId, launcher:detail.launchConfiguration.launcherLabel, form:detail.launchConfiguration.launcherSchemaTitle, projects:detail.launchConfiguration.projects}}} />
  {:else if target.section === "context-map"}
    <section class="context-map-section">
      <div class="context-heading"><h2>Context map</h2><div class="context-views" role="group" aria-label="Context map view"><button class="ui-button" aria-pressed={contextView === "map"} onclick={() => contextView = "map"}>Map</button><button class="ui-button" aria-pressed={contextView === "list"} onclick={() => contextView = "list"}>List</button></div></div>
      <details class="map-description"><summary>About this map</summary><p class="note">Conversation inheritance and explicitly supplied products. Unconnected executions can have unknown context; they are not assumed to be fresh.</p></details>
      {#if target.turnRecordId && !detail.instanceTree.nodes.some(node => node.id === target.turnRecordId)}<p class="notice" role="status">The selected execution is unavailable in this process.</p>{/if}
      {#if !detail.instanceTree.nodes.length}<p class="note">No execution context has been recorded yet.</p>
      {:else if contextView === "map"}<ConversationTreeDiagram tree={detail.instanceTree} railItems={[]} selectedTurnRecordId={target.turnRecordId} onSelectExecution={selectExecution} />
      {:else}
        <h3>Context ancestry list · {detail.instanceTree.nodes.length} executions</h3>
        <ul class="context-list" bind:this={contextList} aria-label="Context ancestry list" tabindex="0">{#each detail.instanceTree.nodes as execution (execution.id)}<li class:selected={target.turnRecordId === execution.id}><button class="text-link" onclick={() => selectExecution(execution.id)}>{execution.label} · {execution.resultState}</button><p class="note">{execution.origin?.summary ?? "Context origin not recorded"}</p>{#each detail.instanceTree.edges.filter(edge => edge.targetNodeId === execution.id && edge.productLabels.length) as edge (edge.id)}<p class="note">Supplied {edge.productLabels.join(", ")} from <button class="text-link" onclick={() => selectExecution(edge.sourceNodeId)}>{detail.instanceTree.nodes.find(node => node.id === edge.sourceNodeId)?.label ?? edge.sourceNodeId}</button></p>{/each}</li>{/each}</ul>
      {/if}
    </section>
  {/if}
</div>
<style>
.process-reference {max-width:960px; margin:0 auto; display:grid; gap:var(--space-lg); min-width:0; overflow-wrap:anywhere;}
.process-overview {gap:var(--space-md);} .process-overview section {gap:var(--space-xs); padding-bottom:var(--space-md);}
section {display:grid; gap:var(--space-md); padding-bottom:var(--space-lg); border-bottom:1px solid var(--chronicle-border); min-width:0;}
h2,h3,p,dl,dd {margin:0;} h2 {font-size:var(--type-title-sm); font-weight:650;} h3 {font-size:var(--type-body); font-weight:650;} p,dl,li {font-size:var(--type-body-sm); line-height:1.65;}
.note,.reference-note,dt {color:var(--chronicle-text-muted);} .reference-note {padding:var(--space-sm) var(--space-md); background:var(--chronicle-panel-muted); border-radius:var(--radius-sm);}
dl {display:grid; gap:var(--space-md);} dl > div {display:grid; grid-template-columns:minmax(120px,1fr) 2fr; gap:var(--space-md);} .fact-grid {grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-xs) var(--space-lg);} .fact-grid > div {grid-template-columns:6rem minmax(0,1fr); gap:var(--space-xs); align-items:baseline;} dt {font-size:var(--type-caption);} code {font-size:var(--type-caption); overflow-wrap:anywhere;}
.repository {display:grid; grid-template-columns:minmax(0,1.4fr) minmax(0,1fr); gap:var(--space-md); padding:var(--space-xs) 0; align-items:start;} .repository-identity {display:grid; gap:var(--space-2xs);} .repository-branches {grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-sm);} .repository-branches > div {display:block;} .ui-button {justify-self:start;}
.text-link {border:0; padding:var(--space-xs) 0; background:transparent; color:var(--chronicle-accent); font:inherit; font-size:var(--type-body-sm); cursor:pointer; text-align:left; text-decoration:underline; text-underline-offset:3px;}
.text-link:focus-visible,.step-list a:focus-visible {outline:2px solid var(--chronicle-accent); outline-offset:3px;}
.step-list {display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-sm) var(--space-lg);} .step-list a {display:flex; align-items:baseline; justify-content:space-between; gap:var(--space-md); padding:var(--space-sm) 0; border-bottom:1px solid var(--chronicle-border); color:var(--chronicle-accent); font-size:var(--type-body-sm); text-decoration:none;}
.transition-list,.resource-list,.context-list {list-style:none; padding:0; margin:0; display:grid; gap:var(--space-sm);} .transition-list li,.resource-list li {display:flex; gap:var(--space-md); align-items:baseline; flex-wrap:wrap;}
.context-map {max-width:none; height:100%; display:flex; flex-direction:column;}
.context-map-section {flex:1; min-height:0; display:flex; flex-direction:column; gap:var(--space-xs); padding-bottom:0; border-bottom:0;}
.context-heading {display:flex; align-items:center; justify-content:space-between; gap:var(--space-sm); flex-wrap:wrap;}
.context-views {display:flex; gap:var(--space-2xs);} .context-views [aria-pressed="true"] {background:var(--chronicle-accent-soft); border-color:var(--chronicle-accent); color:var(--chronicle-accent);}
.map-description {font-size:var(--type-body-sm);} .map-description summary {cursor:pointer; color:var(--chronicle-text-muted);} .map-description p {margin-top:var(--space-xs);}
.context-list {position:relative; flex:1; min-height:0; overflow:auto; align-content:start; gap:0; overscroll-behavior:contain;}
.context-list li {padding:var(--space-xs) var(--space-sm); border-bottom:1px solid var(--chronicle-border);} .context-list li.selected {background:var(--chronicle-accent-soft);}
.context-list:focus-visible,.map-description summary:focus-visible {outline:2px solid var(--chronicle-accent); outline-offset:2px;}
.notice {padding:var(--space-md); background:var(--chronicle-panel-muted); border-radius:var(--radius-sm);}
@media(max-width:720px) {.fact-grid,.step-list,.repository {grid-template-columns:1fr;} dl > div {grid-template-columns:1fr; gap:var(--space-xs);} .fact-grid > div {grid-template-columns:6rem minmax(0,1fr);} .repository {gap:var(--space-xs);} }
</style>

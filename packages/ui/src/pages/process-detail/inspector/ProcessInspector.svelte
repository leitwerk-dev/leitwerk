<script lang="ts">
import ChronicleUsageStats from "../../../chronicle/components/ChronicleUsageStats.svelte";
import type { ProcessDetailData } from "../../../lib/api.js";
import {
	buildInspectorPath,
	type InspectorRoute,
	type InspectorTarget,
} from "../../../lib/router-logic.js";
import { createToolRendererIndex } from "../../../lib/tool-call-rendering.js";
import { wsStore } from "../../../lib/ws.svelte.js";
import ExecutionDetails from "./ExecutionDetails.svelte";
import { createInspectionData } from "./inspection-data.svelte.js";

interface Props {
	instanceId: string;
	target: NonNullable<InspectorRoute>;
	detail: ProcessDetailData | null;
	error: string | null;
	onNavigate: (target: InspectorTarget) => void;
	onBack: () => void;
	onChronicle: (target?: { turnRecordId?: string; turnId?: string }) => void;
	onShowSummary?: () => void;
	onReady?: () => void;
}
let {
	instanceId,
	target,
	detail,
	error,
	onNavigate,
	onBack,
	onChronicle,
	onShowSummary,
	onReady = () => {},
}: Props = $props();
const refreshKey = $derived(
	JSON.stringify([
		detail?.timeline.turns.find(
			(turn) => target.scope === "execution" && turn.id === target.turnRecordId,
		)?.status,
		detail?.session.signature,
		$wsStore.reconnectCount,
	]),
);
const data = createInspectionData({
	get instanceId() {
		return instanceId;
	},
	get target() {
		return target;
	},
	get refreshKey() {
		return refreshKey;
	},
	ready() {
		onReady();
	},
});
const execution = $derived(data.summary?.execution);
const step = $derived(
	detail?.processFlow.nodes.find(
		(node) => node.turnId === (target.scope === "step" ? target.turnId : execution?.turnId),
	),
);
const source = $derived(
	data.summary?.origin.conversation.state === "recorded"
		? data.summary.origin.conversation.value
		: null,
);
const renderers = $derived(createToolRendererIndex(detail?.toolRenderers ?? []));
const sections = $derived(
	target.scope === "execution"
		? [
				["trace", "Trace"],
				["context", "Context"],
				["configuration", "Configuration"],
			]
		: [
				["overview", "Overview"],
				["workflow", "Workflow"],
				["inputs", "Inputs & configuration"],
				["context-map", "Context map"],
			],
);
function sectionTarget(section: string): InspectorTarget {
	if (target.scope === "execution")
		return {
			scope: "execution",
			turnRecordId: target.turnRecordId,
			section: section as "trace" | "context" | "configuration",
		};
	return {
		scope: "process",
		section: section as "overview" | "workflow" | "inputs" | "context-map",
	};
}
</script>

<!-- Process inspector: Operate. Preserve Public Sans, white/gray surfaces and operational blue.
     Identity and context stay above a single evidence reading pane. Explicit links select scope.
     The chronicle retains actions and drafts while hidden. Finish: review and document the built surface. -->
<section class="inspector" aria-labelledby="inspector-heading" data-section="process-inspector">
  <header class="inspector-header">
    <div class="inspector-controls">
      <button class="ui-button" onclick={onBack}>Back</button>
      <button class="ui-button" onclick={() => onChronicle()}>Show in chronicle</button>
    </div>
    <p class="breadcrumbs"><button class="breadcrumb" onclick={() => onNavigate({scope:"process", section:"overview"})}>{detail?.process.title ?? detail?.processDisplayName ?? instanceId}</button>{#if target.scope === "execution" && execution}<span aria-hidden="true"> / </span><button class="breadcrumb" onclick={() => onNavigate({scope:"step", turnId:execution.turnId})}>{step?.description ?? execution.turnId}</button><span aria-hidden="true"> / </span>Execution{:else if target.scope === "step"}<span aria-hidden="true"> / </span>Workflow step{/if}</p>
    <div class="identity-row"><h1 id="inspector-heading" tabindex="-1">{target.scope === "execution" ? `${step?.description ?? execution?.turnId ?? "Execution"}${execution ? ` · Attempt ${execution.attempt}` : ""}` : target.scope === "step" ? step?.description ?? target.turnId : "Process inspector"}</h1>
    {#if target.scope === "execution"}<div class="execution-nav"><button class="ui-button" aria-label="Previous execution" disabled={!data.summary?.previousTurnRecordId} onclick={() => data.summary?.previousTurnRecordId && onNavigate({scope:"execution", turnRecordId:data.summary.previousTurnRecordId, section:target.section})}>Previous</button><button class="ui-button" aria-label="Next execution" disabled={!data.summary?.nextTurnRecordId} onclick={() => data.summary?.nextTurnRecordId && onNavigate({scope:"execution", turnRecordId:data.summary.nextTurnRecordId, section:target.section})}>Next</button></div>{/if}</div>
    {#if target.scope === "execution"}
      <p class="execution-facts"><code>{target.turnRecordId}</code>{#if execution}<span>{execution.turnType} · {execution.status}</span><time datetime={execution.startedAt}>{new Date(execution.startedAt).toLocaleString()}</time>{#if execution.endedAt}<span>{Math.max(0, Math.round((Date.parse(execution.endedAt) - Date.parse(execution.startedAt))/1000))}s</span>{/if}{/if}
      {#if data.summary?.model.state === "recorded"}<span>{data.summary.model.value.provider} / {data.summary.model.value.id}</span>{/if}
      {#if data.summary?.usage}<ChronicleUsageStats usage={data.summary.usage} />{/if}</p>
      <div class="context-summary"><p>{data.summary?.origin.summary ?? data.summaryError ?? "Loading context origin…"}</p><div>{#if source?.turnRecordId}<button class="breadcrumb" onclick={() => onNavigate({scope:"execution", turnRecordId:source.turnRecordId ?? "", section:"trace", entryId:source.entryId, boundaryFor:target.turnRecordId})}>Open source boundary</button>{/if}<button class="breadcrumb" onclick={() => onNavigate({scope:"execution", turnRecordId:target.turnRecordId, section:"context"})}>Inspect context</button></div></div>
    {/if}
    <nav aria-label="Inspector sections">
      {#each sections as [id, label] (id)}
        {@const next = sectionTarget(id)}
        <a href={buildInspectorPath(instanceId, next)} aria-current={"section" in target && target.section === id ? "page" : undefined} onclick={(event) => {if (!event.metaKey && !event.ctrlKey) {event.preventDefault(); onNavigate(next);}}}>{label}</a>
      {/each}
    </nav>
  </header>
  <div class="inspector-scroll" data-role="inspector-scroll" tabindex="0" aria-label="Inspector evidence">
    {#if target.scope === "invalid"}<p role="status">{target.reason}</p>
    {:else if error}<p role="status">{error}</p>
    {:else if !detail}<p role="status">Loading process…</p>
    {:else if target.scope === "execution"}
      <ExecutionDetails {target} {data} toolRendererIndex={renderers} questions={detail?.questionRequests.filter(request => request.turnRecordId === target.turnRecordId) ?? []} {onNavigate} onChronicle={() => onChronicle()} {onReady} />
    {:else}<p role="status">The selected {target.scope} is ready for inspection.</p>{/if}
  </div>
</section>

<style>
.breadcrumb {border:0; padding:0; background:transparent; color:var(--chronicle-accent); font:inherit; cursor:pointer; text-decoration:underline; text-underline-offset:3px;}
.identity-row {display:flex; justify-content:space-between; align-items:start; gap:var(--space-md); flex-wrap:wrap;} .execution-nav {display:flex; gap:var(--space-xs);}
.execution-facts {display:flex; align-items:center; flex-wrap:wrap; gap:var(--space-xs) var(--space-md); margin:var(--space-sm) 0; font-size:var(--type-caption); color:var(--chronicle-text-muted); font-variant-numeric:tabular-nums;}
.context-summary {display:flex; gap:var(--space-sm) var(--space-md); align-items:baseline; justify-content:space-between; flex-wrap:wrap; padding:var(--space-sm) var(--space-md); background:var(--chronicle-panel-muted); border-radius:var(--radius-sm); font-size:var(--type-body-sm); margin-top:var(--space-sm);} .context-summary p {margin:0; overflow-wrap:anywhere;} .context-summary > div {display:flex; gap:var(--space-md); flex-wrap:wrap;}
.inspector {display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; background:var(--chronicle-card-surface); color:var(--chronicle-text);}
.inspector-header {flex:none; padding:var(--space-lg) var(--space-xl) 0; border-bottom:1px solid var(--chronicle-border);}
.inspector-controls {display:flex; justify-content:space-between; gap:var(--space-sm); margin-bottom:var(--space-md);}
.breadcrumbs {margin:0 0 var(--space-xs); font-size:var(--type-body-sm); color:var(--chronicle-text-muted); overflow-wrap:anywhere;}
h1 {margin:0; font-size:var(--type-title-md); font-weight:650; line-height:1.4; overflow-wrap:anywhere;}
nav {display:flex; flex-wrap:wrap; gap:var(--space-xs) var(--space-lg); margin-top:var(--space-lg);}
nav a {color:var(--chronicle-text-muted); text-decoration:none; padding:var(--space-sm) 0; border-bottom:2px solid transparent; font-size:var(--type-body-sm); font-weight:600;}
nav a[aria-current] {color:var(--chronicle-accent); border-bottom-color:var(--chronicle-accent);}
nav a:hover {color:var(--chronicle-text);}
a:focus-visible, h1:focus-visible {outline:2px solid var(--chronicle-accent); outline-offset:4px;}
.inspector-scroll {flex:1; min-height:0; min-width:0; overflow:auto; padding:var(--space-lg) var(--space-xl) var(--space-xl); overscroll-behavior:contain; scrollbar-gutter:stable;}
@media(max-width:720px) {.inspector-header {padding:var(--space-md) var(--space-sm) 0;} .inspector-scroll {padding:var(--space-md) var(--space-sm);} nav {gap:var(--space-sm); margin-top:var(--space-sm);} nav a {font-size:var(--type-caption); min-height:44px; display:flex; align-items:center;} }
</style>

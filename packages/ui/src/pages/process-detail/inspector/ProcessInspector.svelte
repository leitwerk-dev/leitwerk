<script lang="ts">
import type { ProcessDetailData } from "../../../lib/api.js";
import {
	buildInspectorPath,
	type InspectorRoute,
	type InspectorTarget,
} from "../../../lib/router-logic.js";

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
let { instanceId, target, detail, error, onNavigate, onBack, onChronicle }: Props = $props();
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
    <p class="breadcrumbs">{detail?.process.title ?? detail?.processDisplayName ?? instanceId}{#if target.scope === "execution"}<span aria-hidden="true"> / </span>Execution{:else if target.scope === "step"}<span aria-hidden="true"> / </span>Workflow step{/if}</p>
    <h1 id="inspector-heading" tabindex="-1">{target.scope === "execution" ? target.turnRecordId : target.scope === "step" ? target.turnId : "Process inspector"}</h1>
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
    {:else}<p role="status">The selected {target.scope} is ready for inspection.</p>{/if}
  </div>
</section>

<style>
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

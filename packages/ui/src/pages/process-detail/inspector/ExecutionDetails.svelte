<script lang="ts">
import type { ProcessEvent, ProcessQuestionRequest } from "@leitwerk-dev/domain";
import type { ToolCallRendererDefinition } from "@leitwerk-dev/protocol/tool-renderer-contract";
import { tick, untrack } from "svelte";
import ChronicleMarkdown from "../../../chronicle/components/ChronicleMarkdown.svelte";
import ChronicleQuestionRequest from "../../../chronicle/components/ChronicleQuestionRequest.svelte";
import type { InspectorTarget } from "../../../lib/router-logic.js";
import InspectionEvidence from "./InspectionEvidence.svelte";
import InspectionMessage from "./InspectionMessage.svelte";
import { inspectionActivity } from "./inspection-activity.js";
import type { createInspectionData } from "./inspection-data.svelte.js";

let {
	target,
	data,
	toolRendererIndex,
	questions,
	onNavigate,
	onChronicle,
	onReady,
}: {
	target: Extract<InspectorTarget, { scope: "execution" }>;
	data: ReturnType<typeof createInspectionData>;
	toolRendererIndex: Record<string, ToolCallRendererDefinition>;
	questions: readonly ProcessQuestionRequest[];
	onNavigate: (target: InspectorTarget) => void;
	onChronicle: () => void;
	onReady: () => boolean | void;
} = $props();
let root: HTMLDivElement | undefined = $state();
let following = $state(false);
let newActivity = $state(false);
let positioned = "";
const trace = $derived(data.expanded.trace);
const context = $derived(data.expanded.context);
const configuration = $derived(data.expanded.configuration);
const activity = $derived(trace ? inspectionActivity(trace, data.events, data.live) : []);
const scroller = () => root?.closest<HTMLElement>('[data-role="inspector-scroll"]') ?? null;
const selectedKey = $derived(JSON.stringify(target));
$effect(() => {
	selectedKey;
	untrack(() => {
		following = false;
		newActivity = false;
		positioned = "";
	});
});
$effect(() => {
	const count = data.activity;
	if (!count) return;
	untrack(() => {
		if (following)
			void tick().then(() => {
				const el = scroller();
				if (el) el.scrollTop = el.scrollHeight;
			});
		else newActivity = true;
	});
});
$effect(() => {
	const response = trace;
	const key = selectedKey;
	if (
		!response ||
		data.loadedTraceTarget !== key ||
		target.section !== "trace" ||
		positioned === key
	)
		return;
	positioned = key;
	void tick().then(() => {
		if (key !== selectedKey) return;
		if (onReady()) return;
		if (response.target?.state === "available") {
			const targetId = response.target.itemId;
			const message = activity.find(
				(item) => item.kind === "message" && item.message.aliases.includes(targetId),
			);
			const selected = [
				...(root?.querySelectorAll<HTMLElement>("[data-inspection-item]") ?? []),
			].find((el) => el.dataset.inspectionItem === (message?.id ?? targetId));
			selected?.scrollIntoView?.({ block: "start" });
		}
	});
});
function observe(element: HTMLElement) {
	const viewport = element.closest<HTMLElement>('[data-role="inspector-scroll"]');
	const scroll = () => {
		if (viewport && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 48)
			following = false;
	};
	viewport?.addEventListener("scroll", scroll);
	return {
		destroy() {
			viewport?.removeEventListener("scroll", scroll);
		},
	};
}
function follow() {
	following = true;
	newActivity = false;
	const el = scroller();
	if (el) el.scrollTop = el.scrollHeight;
}
function source(turnRecordId: string, entryId: string, boundaryFor?: string) {
	onNavigate({
		scope: "execution",
		turnRecordId,
		section: "trace",
		entryId,
		...(boundaryFor ? { boundaryFor } : {}),
	});
}
function item(id: string) {
	onNavigate({
		...target,
		section: "trace",
		itemId: id,
		entryId: undefined,
		boundaryFor: undefined,
	});
}
function eventLabel(event: ProcessEvent) {
	return event.eventType.replace(/^pi\./, "").replaceAll(/[._]/g, " ");
}
</script>
<div class="execution-details" bind:this={root} use:observe>
  {#if data.error}<div role="status" class="load-error" data-section="inspection-load-error"><p>{data.error}</p><button class="ui-button" onclick={data.retry}>Retry</button></div>{/if}
  {#if data.loading && !data.expanded[target.section]}<p class="loading" role="status">Loading {target.section}…</p>{/if}
  {#if target.section === "trace" && trace}
    {#if trace.state === "live"}<div class="live-controls"><span role="status">{newActivity ? "New activity available" : following ? "Following live" : "Live execution"}</span><button class="ui-button" onclick={follow} disabled={following}>Follow live</button></div>{/if}
    {#if trace.target?.state === "unavailable"}<p class="notice" role="status">{trace.target.reason}</p>{/if}
    {#if data.summary?.execution.turnType === "llm" && data.summary.modelInputCount === 0 && !trace.messages.some(message => message.role === "user")}<p class="note">No model input was recorded for this execution.</p>{/if}
    {#if activity.length === 0}<p class="notice">No trace activity was recorded for this execution.</p>{/if}
    {#each activity as activityItem (activityItem.id)}
      {#if activityItem.kind === "message"}
        <InspectionMessage message={activityItem.message} live={data.live} {toolRendererIndex} onLink={item} />
        {#if trace.inheritedBoundary?.entryId === activityItem.message.entryId}<p class="boundary" data-inspection-boundary>Context inherited through here <span>Later activity below this boundary was not inherited.</span></p>{/if}
      {:else}
        <div class="event" data-inspection-item={activityItem.id}>
          <InspectionEvidence label={eventLabel(activityItem.event)} evidence={{state:"recorded", value:activityItem.event.data}} id={activityItem.id} />
        </div>
      {/if}
    {/each}
    {#if trace.unassignedMessages?.length}<details data-disclosure-key="unassigned-session"><summary>Unassigned session history · ownership not recorded</summary><p class="note">These messages are retained on this session branch. Their execution ownership is unknown; they are not evidence of this execution’s input or inherited context.</p>{#each trace.unassignedMessages as message (message.id)}<InspectionMessage {message} />{/each}</details>{/if}
    {#each trace.annotations as annotation (annotation.id)}<InspectionEvidence label={annotation.annotationType.replaceAll("_", " ")} evidence={{state:"recorded", value:annotation.payload}} id={annotation.id} />{/each}
    {#each questions as request (request.id)}<ChronicleQuestionRequest {request} mode="trace" />{#if request.status === "open"}<button class="ui-button" onclick={onChronicle}>Answer in chronicle</button>{/if}{/each}
    {#if trace.output}<section class="section" data-inspection-item="output"><h2>Execution output</h2><ChronicleMarkdown markdown={trace.output} /></section>{/if}
  {:else if target.section === "context" && context}
    <section class="section"><h2>Inherited conversation</h2><p>{context.origin.summary}</p>
      {#if context.origin.conversation.state === "recorded" && context.origin.conversation.value?.turnRecordId}
        {@const boundary = context.origin.conversation.value}
        <button class="ui-button" onclick={() => source(boundary.turnRecordId ?? "", boundary.entryId, target.turnRecordId)}>Open exact source boundary</button>
      {/if}
      <div class="facts"><InspectionEvidence label="Authored context mode" evidence={context.origin.authoredMode} /><InspectionEvidence label="Resolved start" evidence={context.origin.startTarget} /></div>
      {#if context.ancestry.length}<ol class="ancestry">{#each context.ancestry as ancestor, ancestorIndex (ancestor.turnRecordId)}<li><button class="text-link" onclick={() => source(ancestor.turnRecordId, ancestor.boundaryEntryId, ancestorIndex === 0 ? target.turnRecordId : context.ancestry[ancestorIndex - 1].turnRecordId)}>{ancestor.turnId}</button><span> through {ancestor.boundaryEntryId}</span></li>{/each}</ol>{/if}
    </section>
    {#if context.compactions.length}<section class="section"><h2>Compaction summaries</h2><p class="note">Earlier ancestry explains the source. Compaction can replace that transcript in model input.</p>{#each context.compactions as compaction (compaction.entryId)}<InspectionEvidence label={`Summary ${compaction.entryId}`} evidence={{state:"recorded", value:compaction.summary}} markdown />{/each}</section>{/if}
    <section class="section"><h2>Supplied products</h2>
      {#if "value" in context.products}
        {#if !context.products.value.length}<p class="note">No products were supplied.</p>{/if}
        {#each context.products.value as product (`${product.supplyId}:${product.name}`)}
          <div class="product"><p><strong>{product.name}</strong> · {product.consumed ? "Read by this execution" : "Supplied; no read recorded"}</p><button class="text-link" onclick={() => source(product.producerTurnRecordId, product.entryId)}>Open producing execution</button><InspectionEvidence label="Supplied version" evidence={product.content} markdown id={`${product.supplyId}:${product.name}`} /></div>
        {/each}
      {:else}<p class="note">{context.products.reason}</p>{/if}
    </section>
    <section class="section"><h2>{data.summary?.execution.turnType === "llm" ? "Model inputs" : "Inputs"}</h2>
      {#if "value" in context.modelInputs}
        {#each context.modelInputs.value as revision, index (revision.id)}
          <details class="revision" data-disclosure-key={revision.id} open={index === 0}><summary>Model call {index + 1} · {revision.model.id} · {revision.timestamp}</summary>
          {#each revision.messages as message, messageIndex}
            {#if message.content}<InspectionEvidence label={`${message.role} message ${messageIndex + 1}`} evidence={message.content} id={`${revision.id}:${message.entryId ?? messageIndex}`} />
            {:else if message.sourceTurnRecordId && message.entryId}<p><button class="text-link" onclick={() => source(message.sourceTurnRecordId ?? "", message.entryId ?? "")}>Inherited {message.role} message from {message.sourceTurnRecordId}</button></p>{/if}
          {/each}</details>
        {/each}
      {:else}<p class="note">{context.modelInputs.reason}</p>{/if}
      {#each context.inputMessages as message (message.id)}<InspectionMessage {message} />{/each}
    </section>
    {#if data.summary?.execution.turnType === "llm"}<section class="section"><h2>Instructions</h2><button class="text-link" onclick={() => onNavigate({...target, section:"configuration"})}>Read recorded system prompt, instructions and context files</button></section>{/if}
  {:else if target.section === "configuration" && configuration}
    {#if data.summary?.execution.turnType === "llm"}<InspectionEvidence label="Recorded model selection" evidence={data.summary?.execution.modelProfileId ? {state:"recorded", value:{profileId:data.summary.execution.modelProfileId, provenance:data.summary.execution.modelSelectionProvenance ?? {state:"not_recorded", reason:"Selection source was not recorded"}, startKind:data.summary.startKind}} : {state:"not_recorded", reason:"Model selection provenance was not recorded"}} />
    <p class="note">Model-facing configuration retained at each model call. Available tools can differ from tools actually called in Trace.</p>{/if}
    {#if "value" in configuration.revisions}
      {#each configuration.revisions.value as revision, index (revision.id)}
        <section class="section" data-inspection-item={revision.id}><h2>Model call {index + 1}</h2><p>{revision.model.provider} / {revision.model.id} · {revision.model.thinkingLevel ?? "Thinking level not recorded"}</p><p class="note">{revision.timestamp}</p>
          <InspectionEvidence label="System prompt" evidence={revision.systemPrompt} open={index === 0} />
          <InspectionEvidence label="Appended instructions" evidence={revision.appendedInstructions} id={`${revision.id}:instructions`} />
          <InspectionEvidence label="Context files" evidence={revision.contextFiles} id={`${revision.id}:files`} />
          <InspectionEvidence label="Available tool definitions" evidence={revision.tools} id={`${revision.id}:tools`} />
        </section>
      {/each}
    {:else}<p class="notice" data-evidence-state={configuration.revisions.state}>{configuration.revisions.reason}</p>{/if}
    <section class="section"><h2>Current reference</h2><p class="note">The workflow may have changed since this execution.</p><button class="text-link" onclick={() => onNavigate({scope:"step", turnId:configuration.currentWorkflowTurnId})}>Open current workflow settings</button></section>
  {/if}
</div>
<style>
.execution-details {max-width:960px; margin:0 auto; min-width:0; overflow-wrap:anywhere; display:grid; gap:var(--space-md);}
.section {display:grid; gap:var(--space-sm); padding:var(--space-sm) 0; min-width:0;} h2 {margin:0; font-size:var(--type-title-sm); font-weight:650;} p {margin:0; font-size:var(--type-body-sm); line-height:1.65;} .note {color:var(--chronicle-text-muted);}
.section > button {justify-self:start;} .facts {display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-sm); margin-top:var(--space-sm);}
.boundary {padding:var(--space-md); background:var(--chronicle-accent-soft); color:var(--chronicle-accent); font-weight:650; border:1px solid var(--chronicle-border); border-radius:var(--radius-sm);} .boundary span {display:block; font-weight:400; color:var(--chronicle-text-muted);}
.notice, .loading {padding:var(--space-md); background:var(--chronicle-panel-muted); border-radius:var(--radius-sm);}
.live-controls {display:flex; justify-content:space-between; align-items:center; gap:var(--space-sm); font-size:var(--type-body-sm); position:sticky; top:0; background:var(--chronicle-card-surface); padding:var(--space-xs) 0; z-index:1;}
.text-link {border:0; padding:var(--space-xs) 0; background:transparent; font:inherit; font-size:var(--type-body-sm); color:var(--chronicle-accent); text-align:left; cursor:pointer; text-decoration:underline; text-underline-offset:3px;}
.text-link:focus-visible, summary:focus-visible {outline:2px solid var(--chronicle-accent); outline-offset:3px;} .ancestry {padding-left:var(--space-lg); font-size:var(--type-body-sm);} .product, .revision {display:grid; gap:var(--space-sm); padding:var(--space-sm) 0;} summary {cursor:pointer; padding:var(--space-sm) 0; font-size:var(--type-body-sm);}
@media(max-width:720px) {.facts {grid-template-columns:1fr;}}
</style>

<script lang="ts">
import { Handle, type Node, type NodeProps, Position } from "@xyflow/svelte";
import { type ApiNode, isApi, type UsageMode, type UsageScope } from "./model";
import { dismissNote, focusNote } from "./note-editor";

type CardData = {
	item: ApiNode;
	noteFor: (id: string) => string;
	saveStatus: () => string;
	expanded: boolean;
	more: number;
	siteCount: number;
	siteMode: UsageMode;
	usageScope?: UsageScope | "mixed";
	usageHint?: { label: string; explanation: string };
	sitesVisible: boolean;
	moreSites: number;
	toggleSites: (id: string) => void;
	moreSitesClick: (id: string) => void;
	inspect: (id: string) => void;
	open: (id: string) => void;
	expand: (id: string) => void;
	hide: (id: string) => void;
	moreClick: (id: string) => void;
	save: (id: string, text: string) => void;
	clear: (id: string) => void;
};
let { data, selected }: NodeProps<Node<CardData>> = $props();
const item = $derived(data.item as ApiNode);
let editing = $state(false);
const note = $derived(data.noteFor(item.id));
const sitesLabel = $derived(data.siteMode === "usages" ? "Usages" : "Callers");
const sitesCount = $derived(data.siteCount.toLocaleString());
</script>
<div class="api-card" use:dismissNote={{open:editing,close:()=>editing=false}} class:chosen={selected} class:package-node={item.kind==='package'} class:api-public={isApi(item)&&item.release!=='internal'} class:api-internal={isApi(item)&&item.release==='internal'}>
  <Handle type="target" position={Position.Left} />
  <div class="node-meta"><span class:caller-external={data.usageScope==='external'} class:caller-internal={data.usageScope==='internal'}>{data.usageScope?`${data.usageScope} ${data.siteMode==='usages'?'usages':'caller'}`:item.kind}</span><span>{item.release??(item.isTest?'test':'')}</span></div>
  <button class="node-title nodrag" title={item.qualifiedName??item.label} onclick={()=>data.inspect(item.id)}>{item.label.replace('@leitwerk-dev/','')}</button>
  <div class="node-context">{item.kind==='file'?item.source?.path:item.entry??item.group??item.package.replace('@leitwerk-dev/','')}</div>
  <div class="node-actions nodrag">
    {#if item.kind!=='file'}<button onclick={()=>data.open(item.id)}>Focus</button><button onclick={()=>data.expand(item.id)}>{data.expanded?'Collapse':'Expand'}</button>{/if}
    <button data-note-toggle aria-label={`Edit note for ${item.label}`} onclick={()=>editing=!editing}>{editing?'Done':note?'Note •':'Note'}</button>
    <button aria-label={`Hide ${item.label}`} onclick={()=>data.hide(item.id)}>Hide</button>
  </div>
  {#if item.kind!=='file'}
    <button class="node-call-sites nodrag" aria-label={`${sitesLabel} (${sitesCount}) for ${item.label}`} aria-pressed={data.sitesVisible} disabled={!data.siteCount&&!data.sitesVisible} title={data.siteCount?`${sitesCount} ${data.siteMode} match the current filters`:`No ${sitesLabel.toLowerCase()} match the current filters`} onclick={()=>data.toggleSites(item.id)}>{sitesLabel} <span class="count">({sitesCount})</span></button>
  {/if}
  {#if data.usageHint}<button class="node-evidence nodrag" title={data.usageHint.explanation} onclick={()=>data.inspect(item.id)}>{data.usageHint.label}</button>{/if}
  {#if data.moreSites>0}<button class="more nodrag" onclick={()=>data.moreSitesClick(item.id)}>More {sitesLabel.toLowerCase()} ({data.moreSites})</button>{/if}
  {#if data.more>0}<button class="more nodrag" onclick={()=>data.moreClick(item.id)}>Show more ({data.more})</button>{/if}
  {#if editing}
    <div class="nodrag nowheel" data-note-editor><label class="node-editor">Markdown note<textarea use:focusNote aria-label={`Note for ${item.label}`} value={note} oninput={e=>data.save(item.id,e.currentTarget.value)} rows="5" placeholder="What should you remember about this API?"></textarea></label><div class="note-editor-footer"><span class="save-status" role="status">{data.saveStatus()}</span><button disabled={!note} aria-label={`Clear note for ${item.label}`} onclick={()=>{data.clear(item.id);editing=false;}}>Clear</button></div></div>
  {/if}
  <Handle type="source" position={Position.Right} />
</div>

<script lang="ts">
import { onMount } from "svelte";
import PageHeader from "../components/PageHeader.svelte";
import { fetchDashboard } from "../lib/api.js";
import { createDashboardRefresh, type DashboardLoadState } from "../lib/dashboard-refresh.js";
import {
	buildCreateProcessPath,
	buildProcessesPath,
	buildSkillsPath,
	buildWatchersPath,
	followLink,
} from "../lib/router.svelte.js";
import { wsStore } from "../lib/ws.svelte.js";

let snapshot = $state<DashboardLoadState>({ data: null, loading: true, error: null });
const loader = createDashboardRefresh(fetchDashboard, (state) => {
	snapshot = state;
});
let grouping = $state<"status" | "definition">("status");
let allModels = $state(false);
let allIssues = $state(false);
const data = $derived(snapshot.data);
const definitions = $derived(data?.definitions.items ?? []);
const watchers = $derived(data?.watchers.items ?? []);
const rankedDefinitions = $derived(data?.processes.byDefinition ?? []);
const processMaximum = $derived(Math.max(1, ...rankedDefinitions.map((item) => item.count)));
const modelMaximum = $derived(
	Math.max(0, ...(data?.costs.byModel.map((item) => item.costUsd) ?? [])),
);
const usd = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 4,
});
function statusLabel(status: string) {
	return status.charAt(0).toUpperCase() + status.slice(1);
}

onMount(() => {
	void loader.refresh();
	let reconnectCount: number | null = null;
	const unsubscribe = wsStore.subscribe((connection) => {
		if (reconnectCount !== null && connection.reconnectCount > reconnectCount)
			void loader.refresh();
		reconnectCount = connection.reconnectCount;
	});
	const visible = () => {
		if (document.visibilityState === "visible") void loader.refresh();
	};
	document.addEventListener("visibilitychange", visible);
	const timer = setInterval(visible, 30_000);
	return () => {
		clearInterval(timer);
		document.removeEventListener("visibilitychange", visible);
		unsubscribe();
		loader.dispose();
	};
});
</script>

<div class="dashboard" data-page="dashboard">
 <PageHeader title="Dashboard" subtitle="An overview of your processes, resources, and model readiness.">
  {#snippet actions()}
   <a class="ui-button" data-variant="primary" href={buildCreateProcessPath()} onclick={(event) => followLink(event, buildCreateProcessPath())}>Start a process</a>
   <button type="button" class="ui-button" disabled={snapshot.loading} onclick={() => void loader.refresh()}>{snapshot.loading ? "Refreshing…" : "Refresh"}</button>
  {/snippet}
 </PageHeader>
 {#if snapshot.error}
  <div class="refresh-error" role="alert"><p>{snapshot.error} {data ? "Showing the last loaded overview." : ""}</p><button type="button" class="ui-button" disabled={snapshot.loading} onclick={() => void loader.refresh()}>Retry</button></div>
 {/if}
 {#if !data}
  {#if snapshot.loading}<p role="status" class="empty">Loading dashboard…</p>{/if}
 {:else}
  <div class="catalogs">
   <a class="catalog" href={buildCreateProcessPath()} onclick={(event) => followLink(event, buildCreateProcessPath())}>
    <h2>Process definitions <span class="count">{data.definitions.total}</span></h2>
    {#if definitions.length}<ul>{#each definitions.slice(0, 3) as item (item.id)}<li>{item.name}</li>{/each}</ul>{:else}<p>No process definitions loaded.</p>{/if}
    {#if data.definitions.total > 3}<p class="more">+{data.definitions.total - 3} more</p>{/if}
   </a>
   <a class="catalog" href={buildWatchersPath()} onclick={(event) => followLink(event, buildWatchersPath())}>
    <h2>Watchers <span class="count">{data.watchers.total}</span></h2><p>{data.watchers.enabled} enabled</p>
    {#if watchers.length}<ul>{#each watchers.slice(0, 3) as item (item.id)}<li>{item.name}</li>{/each}</ul>{:else}<p>No watchers registered.</p>{/if}
    {#if data.watchers.total > 3}<p class="more">+{data.watchers.total - 3} more</p>{/if}
   </a>
   <a class="catalog" href={buildSkillsPath()} onclick={(event) => followLink(event, buildSkillsPath())}>
    <h2>Skills <span class="count">{data.skills.total}</span></h2>
    <dl class="skill-totals"><div><dt>Installed</dt><dd>{data.skills.installed}</dd></div><div><dt>Bundled</dt><dd>{data.skills.bundled}</dd></div></dl>
    {#if !data.skills.total}<p>No skills available.</p>{/if}
   </a>
  </div>
  <div class="overview">
   <section class="panel" aria-labelledby="dashboard-processes">
    <header class="panel-header"><h2 id="dashboard-processes">Processes <span class="count">{data.processes.total}</span></h2><a href={buildProcessesPath()} onclick={(event) => followLink(event, buildProcessesPath())}>View processes</a></header>
    <p class="muted">All retained process instances</p>
    <div class="grouping" role="group" aria-label="Group processes"><button type="button" aria-pressed={grouping === "status"} onclick={() => { grouping = "status"; }}>By status</button><button type="button" aria-pressed={grouping === "definition"} onclick={() => { grouping = "definition"; }}>By definition</button></div>
    {#if data.processes.total === 0}<p class="empty">No processes yet. Start a process to see its progress here.</p>
    {:else if grouping === "status"}
     <div class="status-bar" aria-hidden="true">{#each data.processes.byStatus.filter((item) => item.count > 0) as item (item.status)}<span data-status={item.status} style:flex-grow={item.count}></span>{/each}</div>
     <dl class="status-list">{#each data.processes.byStatus as item (item.status)}<div><dt><span class="status-dot" data-status={item.status} aria-hidden="true"></span>{statusLabel(item.status)}</dt><dd>{item.count}</dd></div>{/each}</dl>
    {:else}
     <ul class="ranked">{#each rankedDefinitions as item (item.processId)}<li><div class="row-label"><span>{item.name}</span><strong>{item.count}</strong></div><div class="track" aria-hidden="true"><span style:width={`${(item.count / processMaximum) * 100}%`}></span></div></li>{/each}</ul>
    {/if}
   </section>
   <section class="panel" aria-labelledby="dashboard-costs">
    <header class="panel-header"><h2 id="dashboard-costs">LLM costs</h2><span class="muted">All time · estimated USD</span></header>
    {#if data.costs.totalLlmTurnCount === 0}<p class="empty">No LLM usage recorded yet.</p>
    {:else if data.costs.totalUsd === null}<p class="empty">Cost unavailable. Recorded LLM turns have no cost information.</p>
    {:else}
     <p class="cost-total">{usd.format(data.costs.totalUsd)}</p>
     {#if data.costs.totalUsd === 0}<p class="muted">Recorded usage has zero estimated cost.</p>{/if}
     {#if data.costs.isPartial}<p class="coverage">Partial coverage: {data.costs.pricedTurnCount} of {data.costs.totalLlmTurnCount} LLM turns include cost. {data.costs.missingCostTurnCount} have no recorded cost.</p>{/if}
     <ul class="cost-list">{#each data.costs.byModel.slice(0, allModels ? undefined : 5) as model}<li><div class="cost-row"><div><span>{model.modelId ?? "Unknown model"}</span><small>{model.providerId ?? "Unknown provider"} · {model.turnCount} {model.turnCount === 1 ? "priced turn" : "priced turns"}</small></div><strong>{usd.format(model.costUsd)}</strong></div><div class="track cost-track" aria-hidden="true"><span style:width={`${modelMaximum > 0 ? (model.costUsd / modelMaximum) * 100 : 0}%`}></span></div></li>{/each}</ul>
     {#if data.costs.byModel.length > 5}<button type="button" class="text-button" aria-expanded={allModels} onclick={() => { allModels = !allModels; }}>{allModels ? "Show fewer models" : `Show all ${data.costs.byModel.length} models`}</button>{/if}
    {/if}
   </section>
  </div>
  <section class="panel configuration" aria-labelledby="dashboard-configuration">
   <header class="panel-header"><h2 id="dashboard-configuration">Configuration issues</h2>{#if data.configuration.issues.length}<span class="muted">{data.configuration.issues.length} {data.configuration.issues.length === 1 ? "issue" : "issues"}</span>{/if}</header>
   {#if !data.configuration.issues.length}<p class="healthy">No model readiness issues detected.</p>
   {:else}
    <ul class="issues">{#each data.configuration.issues.slice(0, allIssues ? undefined : 3) as issue (issue.id)}<li><span class="severity" data-severity={issue.severity}>{statusLabel(issue.severity)}</span><div><p>{issue.message}</p><div class="sources">{#each issue.sources as source}{#if source.href}<a href={source.href} onclick={(event) => followLink(event, source.href ?? "/")}>{source.label}</a>{:else}<span>{source.label}</span>{/if}{/each}</div></div></li>{/each}</ul>
    {#if data.configuration.issues.length > 3}<button type="button" class="text-button" aria-expanded={allIssues} onclick={() => { allIssues = !allIssues; }}>{allIssues ? "Show fewer issues" : `Show all ${data.configuration.issues.length} issues`}</button>{/if}
   {/if}
  </section>
  <p class="updated">Updated <time datetime={data.generatedAt}>{new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></p>
 {/if}
</div>

<style>
 .dashboard { display: grid; gap: var(--space-lg); min-width: 0; padding: var(--space-2xs) 2px var(--space-xl); color: var(--chronicle-text); font-size: var(--type-body); }
 .catalogs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-md); }
 .catalog { display: block; padding: var(--space-md) var(--space-lg); border-radius: 14px; background: var(--chronicle-panel-muted); color: inherit; text-decoration: none; transition: background 150ms ease-out; }
 .catalog:hover { background: var(--chronicle-accent-soft); }
 h2 { margin: 0; font-size: var(--type-title-sm); font-weight: 650; line-height: 1.35; }
 .count { margin-left: var(--space-xs); color: var(--chronicle-text-muted); font-weight: 500; font-variant-numeric: tabular-nums; }
 p { margin: var(--space-xs) 0 0; line-height: 1.55; }
 .catalog p, .muted, .updated, small { color: var(--chronicle-text-muted); font-size: var(--type-body-sm); }
 ul { list-style: none; padding: 0; margin: var(--space-sm) 0 0; }
 .catalog li { overflow-wrap: anywhere; line-height: 1.6; }
 .more { color: var(--chronicle-accent); }
 .skill-totals { margin: var(--space-sm) 0 0; display: grid; gap: var(--space-xs); }
 .skill-totals div, .status-list div { display: flex; justify-content: space-between; gap: var(--space-md); }
 dd { margin: 0; font-variant-numeric: tabular-nums; }
 .overview { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: var(--space-lg); }
 .panel { min-width: 0; padding: var(--space-lg); border: 1px solid var(--chronicle-border); border-radius: 14px; }
 .panel-header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: var(--space-sm); }
 a:not(.ui-button):not(.catalog), .text-button { color: var(--chronicle-accent); text-underline-offset: 3px; }
 a:focus-visible, button:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 4px; }
 .grouping { display: inline-flex; flex-wrap: wrap; margin-top: var(--space-lg); padding: 3px; gap: 3px; background: var(--chronicle-panel-muted); border-radius: 10px; }
 .grouping button { border: 0; border-radius: 7px; padding: 8px 12px; background: transparent; color: var(--chronicle-text-muted); font: inherit; cursor: pointer; }
 .grouping button[aria-pressed="true"] { color: var(--chronicle-text); background: var(--chronicle-card-surface); }
 .grouping button:hover { color: var(--chronicle-text); }
 .status-bar { display: flex; height: 16px; overflow: hidden; border-radius: 4px; margin-top: var(--space-lg); gap: 3px; }
 [data-status="running"] { background: var(--chronicle-accent); }
 [data-status="waiting"] { background: var(--chronicle-attention); }
 [data-status="error"] { background: var(--chronicle-danger); }
 [data-status="completed"] { background: var(--chronicle-success); }
 [data-status="aborted"] { background: var(--chronicle-text-muted); }
 .status-list { display: grid; gap: var(--space-sm); margin: var(--space-md) 0 0; }
 .status-list dt { display: flex; align-items: center; gap: var(--space-xs); }
 .status-dot { width: 8px; height: 8px; border-radius: 50%; }
 .ranked li { margin-bottom: var(--space-md); }
 .row-label { display: flex; justify-content: space-between; gap: var(--space-md); }
 .row-label span, .cost-list span, .sources { overflow-wrap: anywhere; }
 .track { margin-top: 6px; height: 7px; border-radius: 3px; background: var(--chronicle-panel-muted); overflow: hidden; }
 .track span { display: block; height: 100%; background: var(--chronicle-accent); }
 .cost-total { font-size: 1.65rem; font-weight: 620; font-variant-numeric: tabular-nums; margin-top: var(--space-lg); }
 .coverage { font-size: var(--type-body-sm); color: var(--chronicle-text-muted); }
 .cost-list li { padding: var(--space-sm) 0; }
 .cost-row { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-md); }
 .cost-track span { background: var(--chronicle-text-muted); }
 .cost-row > div { min-width: 0; }
 .cost-list small { display: block; margin-top: 3px; }
 strong { font-weight: 620; font-variant-numeric: tabular-nums; }
 .cost-list strong { white-space: nowrap; }
 .text-button { background: transparent; border: 0; font: inherit; padding: var(--space-sm) 0; text-decoration: underline; cursor: pointer; }
 .text-button:hover { color: var(--chronicle-text); }
 .issues li { display: flex; align-items: baseline; gap: var(--space-md); padding: var(--space-md) 0; border-top: 1px solid var(--chronicle-border); }
 .issues li > div { min-width: 0; }
 .issues p { margin: 0; overflow-wrap: anywhere; }
 .severity { flex: 0 0 auto; font-weight: 620; font-size: var(--type-body-sm); }
 .severity[data-severity="error"] { color: var(--chronicle-danger-text); }
 .severity[data-severity="warning"] { color: var(--chronicle-attention); }
 .sources { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-md); margin-top: var(--space-xs); color: var(--chronicle-text-muted); font-size: var(--type-body-sm); }
 .healthy { color: var(--chronicle-success); font-weight: 550; }
 .empty { padding: var(--space-lg) 0; color: var(--chronicle-text-muted); max-width: 68ch; }
 .refresh-error { display: flex; justify-content: space-between; align-items: center; gap: var(--space-md); padding: var(--space-md); border-radius: 14px; background: color-mix(in srgb, var(--chronicle-danger) 7%, white); color: var(--chronicle-danger-text); }
 .refresh-error p { margin: 0; }
 .updated { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
 @media (max-width: 900px) { .catalogs { grid-template-columns: 1fr; } .overview { grid-template-columns: 1fr; } }
 @media (max-width: 540px) { .panel, .catalog { padding: var(--space-md); } .issues li, .refresh-error { align-items: flex-start; flex-direction: column; gap: var(--space-xs); } }
 @media (prefers-reduced-motion: reduce) { .catalog { transition: none; } }
</style>

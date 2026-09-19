<script lang="ts">
import { internalDependencies } from "./internal-dependencies";
import type { Snapshot } from "./model";

let { snapshot, open }: { snapshot: Snapshot; open: (id: string) => void } = $props();
let repository = $state("");
let targetPackage = $state("");
let assessment = $state("");
let scope = $state("");
let query = $state("");
let limit = $state(60);
let exportError = $state("");
const findings = $derived(internalDependencies(snapshot));
const repositories = $derived([...new Set([
	...(snapshot.reports?.map(report => report.name) ?? [snapshot.repository.name]),
	...findings.map(f => f.repository),
])].sort());
const packages = $derived([...new Set(findings.map(f => f.targetPackage))].sort());
const matches = $derived(findings.filter(f =>
	(!repository || f.repository === repository) &&
	(!targetPackage || f.targetPackage === targetPackage) &&
	(!assessment || f.assessment === assessment) &&
	(!scope || f.usages.some(o => scope === "test" ? o.isTest : !o.isTest)) &&
	`${f.repository} ${f.consumerPackage} ${f.targetPackage} ${f.api.qualifiedName ?? f.api.label} ${f.usages.map(o => o.path).join(" ")}`.toLowerCase().includes(query.toLowerCase()),
));
function reset() {
	repository = targetPackage = assessment = scope = query = "";
	limit = 60;
}
function exportFindings() {
	exportError = "";
	try {
		const blob = new Blob([JSON.stringify({
			schemaVersion: 1, kind: "internal-api-dependencies", generatedAt: snapshot.generatedAt,
			advisory: true, coverage: snapshot.coverage, reports: snapshot.reports,
			filters: { repository, targetPackage, assessment, scope, query }, findings: matches,
		})], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = "internal-api-dependencies.json";
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	} catch (error) {
		exportError = `Could not export dependencies: ${String(error)}. Narrow the filters and try again.`;
	}
}
</script>

<div class="notes-page dependencies-page">
	<div class="page-heading">
		<div><h2>Internal API dependencies</h2><p>Cross-package references to APIs classified as internal. Advisory only: current builds permit this usage.</p></div>
		<button disabled={!matches.length} onclick={exportFindings}>Export dependencies ({matches.length})</button>
	</div>
	<p>Warnings identify resolved routes with matching package versions. Needs review means the route, version, or consumer is uncertain. These are static references, not runtime call traces.</p>
	{#if !snapshot.coverage.complete || snapshot.reportLoadingIncomplete}
		<p class="coverage-warning">Loaded-source coverage is incomplete. Positive evidence is shown; no findings does not establish that internal APIs are unused.</p>
	{/if}
	{#if exportError}<p role="alert">{exportError}</p>{/if}
	<div class="candidate-filters">
		<label>Find a dependency<input type="search" placeholder="API, package, or caller path…" bind:value={query} oninput={() => limit = 60}/></label>
		<label>Consumer repository<select bind:value={repository} onchange={() => limit = 60}><option value="">All repositories</option>{#each repositories as name (name)}<option>{name}</option>{/each}</select></label>
		<label>Target package<select bind:value={targetPackage} onchange={() => limit = 60}><option value="">All packages</option>{#each packages as name (name)}<option>{name}</option>{/each}</select></label>
		<label>Assessment<select bind:value={assessment} onchange={() => limit = 60}><option value="">All assessments</option><option value="warning">Warning</option><option value="needs-review">Needs review</option></select></label>
		<label>Usage scope<select bind:value={scope} onchange={() => limit = 60}><option value="">Production and tests</option><option value="production">Has production references</option><option value="test">Has test references</option></select></label>
	</div>
	<p role="status">{matches.length} of {findings.length} dependencies match. Explorer filters do not affect this analysis. Details and export retain all evidence for each match.</p>
	{#if repository || targetPackage || assessment || scope || query}<button onclick={reset}>Clear dependency filters</button>{/if}
	{#each matches.slice(0, limit) as finding, i (finding.id)}
		{#if i === 0 || matches[i - 1].repository !== finding.repository}
			<h3 class="repository-heading">{finding.repository}</h3>
		{/if}
		{#if i === 0 || matches[i - 1].repository !== finding.repository || matches[i - 1].targetPackage !== finding.targetPackage}
			<h4 class="package-heading">{finding.targetPackage}</h4>
		{/if}
		<article class="dependency-row">
			<div class="dependency-heading">
				<div><button class="api-link" onclick={() => open(finding.api.id)}>{finding.api.qualifiedName ?? finding.api.label}</button><p>From {finding.consumerPackage}</p></div>
				<span class="assessment">{finding.assessment === "warning" ? "Warning" : "Needs review"}</span>
			</div>
			<p>{finding.usages.filter(o => !o.isTest).length} production · {finding.usages.filter(o => o.isTest).length} test references</p>
			<p class="version-detail">Consumed {finding.consumerVersion ?? "unknown"} · Catalog {finding.catalogVersion ?? "unknown"}</p>
			{#each finding.reasons as reason (reason)}<p>{reason}</p>{/each}
			<details>
				<summary>Caller locations and routes ({finding.usages.length} references)</summary>
				<p class="routes">Routes: {finding.routes.map(route => `${route.entry ?? "."} → ${route.qualifiedName ?? route.label}`).join(", ")}</p>
				{#each finding.usages as usage (usage.id)}
					<details class="caller">
						<summary><span>{usage.path}:{usage.line}:{usage.column}</span><small>{usage.kind} · {usage.isTest ? "test" : "production"}</small></summary>
						<pre class="source-code"><code>{usage.snippet || "No source snippet was recorded."}</code></pre>
					</details>
				{/each}
			</details>
		</article>
	{:else}
		<p class="empty">{findings.length ? "No dependencies match these filters. Clear the filters to see all findings." : "No cross-package internal API references found in the loaded evidence. This does not prove absence of other consumers."}</p>
	{/each}
	{#if matches.length > limit}<button onclick={() => limit += 60}>Show more dependencies ({matches.length - limit})</button>{/if}
</div>

<style>
.dependencies-page { max-width: 1100px; margin-inline: auto; }
.dependencies-page p { line-height: 1.6; overflow-wrap: anywhere; }
.repository-heading { margin-top: 32px; font-size: 18px; }
.package-heading { margin-top: 24px; margin-bottom: 8px; overflow-wrap: anywhere; }
.dependency-row { padding: 16px 0; border-bottom: 1px solid var(--border); }
.dependency-heading { display: flex; justify-content: space-between; align-items: start; gap: 16px; }
.api-link { text-align: left; overflow-wrap: anywhere; font-weight: 600; }
.assessment { flex-shrink: 0; color: #744808; background: #fff3d7; border-radius: 4px; padding: 4px 8px; }
.version-detail { color: var(--muted); font-variant-numeric: tabular-nums; }
.coverage-warning { color: #744808; }
summary { cursor: pointer; padding: 8px 0; overflow-wrap: anywhere; }
summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.caller { margin-left: 16px; }
.caller small { display: block; margin: 4px 0 0 16px; }
.routes { margin: 8px 0; }
@media (max-width: 600px) { .dependency-heading { flex-direction: column; gap: 8px; } }
</style>

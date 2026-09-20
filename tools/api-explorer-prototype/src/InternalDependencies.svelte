<script lang="ts">
import { internalDependencies } from "./internal-dependencies";
import type { Snapshot } from "./model";

let { snapshot, open }: { snapshot: Snapshot; open: (id: string) => void } = $props();
let targetPackage = $state("");
let query = $state("");
let limit = $state(60);
let exportError = $state("");
const findings = $derived(internalDependencies(snapshot));
const violations = $derived(findings.filter((finding) => finding.assessment === "forbidden"));
const hasUncertainEvidence = $derived(findings.some((finding) => finding.assessment === "needs-review"));
const targetPackages = $derived([...new Set(violations.map((finding) => finding.targetPackage))].sort());
const matches = $derived(
	violations.filter(
		(f) =>
			(!targetPackage || f.targetPackage === targetPackage) &&
			`${f.repository} ${f.consumerPackage} ${f.targetPackage} ${f.api.qualifiedName ?? f.api.label} ${f.usages.map((o) => o.path).join(" ")}`
				.toLowerCase()
				.includes(query.toLowerCase()),
	),
);
function reset() {
	targetPackage = query = "";
	limit = 60;
}
function exportFindings() {
	exportError = "";
	try {
		const blob = new Blob(
			[
				JSON.stringify({
					schemaVersion: 2,
					kind: "internal-api-dependencies",
					generatedAt: snapshot.generatedAt,
					advisory: true,
					coverage: snapshot.coverage,
					reports: snapshot.reports,
					filters: { targetPackage, assessment: "forbidden", query },
					findings: matches,
				}),
			],
			{ type: "application/json" },
		);
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = "internal-api-dependencies.json";
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	} catch (error) {
		exportError = `Could not export violations: ${String(error)}. Narrow the filters and try again.`;
	}
}
</script>

<div class="notes-page dependencies-page">
	<div class="page-heading">
		<div><h2>Internal API violations</h2><p>Forbidden cross-package references in Leitwerk and external workspace code, including tests. Composition/base sources and allowed dependencies are excluded.</p></div>
		<button disabled={!matches.length} onclick={exportFindings}>Export violations ({matches.length})</button>
	</div>
	<p>Replace internal imports with supported public APIs, or move the behavior into its owning package. These findings are advisory, not CI enforcement.</p>
	{#if !snapshot.coverage.complete || snapshot.reportLoadingIncomplete}
		<p class="coverage-warning">Loaded-source coverage is incomplete. More violations may exist outside the analyzed sources.</p>
	{/if}
	{#if hasUncertainEvidence}
		<details class="coverage-warning"><summary>Some references could not be assessed</summary><p>References with unresolved ownership, ambiguous routes, or uncertain package versions are not counted as violations. Regenerate reports from matching source versions and check report diagnostics; unresolved evidence still requires manual review.</p></details>
	{/if}
	{#if exportError}<p role="alert">{exportError}</p>{/if}
	<div class="candidate-filters">
		<label>Find a violation<input type="search" placeholder="API, package, or caller path…" bind:value={query} oninput={() => limit = 60}/></label>
		<label>API package<select bind:value={targetPackage} onchange={() => limit = 60}><option value="">All API packages</option>{#each targetPackages as name (name)}<option>{name}</option>{/each}</select></label>

	</div>
	<p role="status">{#if targetPackage || query}{matches.length} of {violations.length} violations match.{:else}{violations.length} {violations.length === 1 ? "violation" : "violations"}.{/if}</p>
	{#if targetPackage || query}<button onclick={reset}>Clear filters</button>{/if}
	{#each matches.slice(0, limit) as finding, i (finding.id)}
		{#if i === 0 || matches[i - 1].targetPackage !== finding.targetPackage}
			<h3 class="package-heading">{finding.targetPackage}</h3>
		{/if}
		<article class="dependency-row">
			<div class="dependency-heading">
				<div><button class="api-link" onclick={() => open(finding.api.id)}>{finding.api.qualifiedName ?? finding.api.label}</button><p>From {finding.consumerPackage} · {finding.repository}</p></div>
				<div class="badges"><span class="origin origin-{finding.consumerSource}">{finding.consumerSource === "workspace" ? "Workspace" : finding.consumerSource === "catalog" ? "Catalog" : "Unknown source"}</span><span class="assessment assessment-{finding.assessment}">Forbidden internal dependency</span></div>
			</div>
			<p>{finding.usages.filter(o => !o.isTest).length} production · {finding.usages.filter(o => o.isTest).length} test references</p>
			<p>{finding.consumerOwnership} → {finding.targetOwnership}: {finding.policyReason}</p>
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
		<p class="empty">{violations.length ? "No violations match these filters. Clear the filters to see all violations." : "No confirmed internal API violations in the loaded evidence."}</p>
	{/each}
	{#if matches.length > limit}<button onclick={() => limit += 60}>Show more violations ({matches.length - limit})</button>{/if}
</div>

<style>
.dependencies-page { max-width: 1100px; margin-inline: auto; }
.candidate-filters { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
@media (max-width: 600px) { .candidate-filters { grid-template-columns: minmax(0, 1fr); } }
.dependencies-page p { line-height: 1.6; overflow-wrap: anywhere; }
.package-heading { margin-top: 24px; margin-bottom: 8px; overflow-wrap: anywhere; }
.dependency-row { padding: 16px 0; border-bottom: 1px solid var(--border); }
.dependency-heading { display: flex; justify-content: space-between; align-items: start; gap: 16px; }
.api-link { text-align: left; overflow-wrap: anywhere; font-weight: 600; }
.assessment { flex-shrink: 0; color: #744808; background: #fff3d7; border-radius: 4px; padding: 4px 8px; }
.assessment-forbidden { color: #842b24; background: #fce8e5; }
.badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.origin { flex-shrink: 0; border-radius: 4px; padding: 4px 8px; color: var(--muted); background: var(--surface-raised, #f2f3f5); }
.origin-workspace { color: #174d31; background: #e1f4e8; }
.version-detail { color: var(--muted); font-variant-numeric: tabular-nums; }
.coverage-warning { color: #744808; }
summary { cursor: pointer; padding: 8px 0; overflow-wrap: anywhere; }
summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.caller { margin-left: 16px; }
.caller small { display: block; margin: 4px 0 0 16px; }
.routes { margin: 8px 0; }
@media (max-width: 600px) { .dependency-heading { flex-direction: column; gap: 8px; } }
</style>

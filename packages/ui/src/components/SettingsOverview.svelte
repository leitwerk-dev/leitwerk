<script lang="ts">
import type {
	SettingChoice,
	SettingsOverviewResponse,
	SettingsScopeOverview,
	SettingsScopesResponse,
} from "@leitwerk-dev/protocol/http-contracts";
import { onMount, type Snippet, tick } from "svelte";
import { locationStore, navigate } from "../lib/router.svelte.js";
import { fetchSettingsOverview, onSettingsChanged } from "../lib/settings.js";

let {
	scopeType,
	overview,
	label,
	subjects,
	selected,
	panelOpen,
	refreshVersion = 0,
	onSelect,
	onClose,
	children,
	refresh,
}: {
	scopeType: string;
	overview?: SettingsScopeOverview;
	label: string;
	subjects: SettingsScopesResponse["subjects"];
	selected: string;
	panelOpen: boolean;
	refreshVersion?: number;
	onSelect: (id: string) => void;
	onClose: () => void;
	children?: Snippet;
	refresh?: Snippet;
} = $props();
let items = $state<SettingsOverviewResponse["items"]>([]);
let loading = $state(true);
let error = $state("");
let loadId = 0;
const params = $derived(new URL($locationStore, window.location.origin).searchParams);
const query = $derived(params.get("q") ?? "");
const filter = $derived(params.get("filter") ?? "all");
const project = $derived(params.get("project") ?? "");
const mapping = $derived(items.some((item) => item.mapping !== undefined));
const rows = $derived(
	[...subjects]
		.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
		.map((subject) => ({
			...subject,
			summary: items.find((item) => item.subjectId === subject.id),
			project:
				overview?.parentLabel &&
				overview.labelSeparator &&
				subject.label.includes(overview.labelSeparator)
					? subject.label.split(overview.labelSeparator)[0]
					: "",
			name: overview?.labelSeparator
				? subject.label.split(overview.labelSeparator).slice(1).join(overview.labelSeparator) ||
					subject.label
				: subject.label,
		})),
);
const projects = $derived([...new Set(rows.map((row) => row.project).filter(Boolean))].sort());
const projectRows = $derived(rows.filter((row) => !project || row.project === project));
function status(row: (typeof rows)[number]) {
	if (!row.summary) return loading ? "loading" : "unavailable";
	if (row.summary.errors.length) return "error";
	if (mapping)
		return row.summary.mapping === undefined
			? "unavailable"
			: row.summary.mapping.length
				? "mapped"
				: "unmapped";
	return row.summary.customized.length ? "customized" : "defaults";
}
const filters = $derived(
	mapping
		? [
				{ id: "all", label: "All" },
				{ id: "mapped", label: "Mapped" },
				{ id: "unmapped", label: "Unmapped" },
			]
		: [
				{ id: "all", label: "All" },
				{ id: "customized", label: "Customized" },
				{ id: "defaults", label: "Using defaults" },
			],
);
const visibleRows = $derived(
	projectRows.filter(
		(row) =>
			(filter === "all" || status(row) === filter) &&
			`${row.label} ${row.summary?.mapping?.map((choice) => choice.label).join(" ") ?? ""} ${row.summary?.customized.join(" ") ?? ""}`
				.toLowerCase()
				.includes(query.trim().toLowerCase()),
	),
);
const nextUnmapped = $derived(
	projectRows.find(
		(row) =>
			row.id !== selected &&
			status(row) === "unmapped" &&
			`${row.label} ${row.summary?.mapping?.map((c) => c.label).join(" ") ?? ""}`
				.toLowerCase()
				.includes(query.trim().toLowerCase()),
	),
);
function update(key: string, value: string, replace = false) {
	const url = new URL($locationStore, window.location.origin);
	url.pathname = "/settings";
	url.searchParams.set("scope", selected);
	if (value && value !== "all") url.searchParams.set(key, value);
	else url.searchParams.delete(key);
	navigate(`${url.pathname}${url.search}`, { replace });
}
async function reload() {
	const id = ++loadId;
	error = "";
	try {
		const result = await fetchSettingsOverview(scopeType);
		if (id === loadId) items = result.items;
	} catch (caught) {
		if (id === loadId)
			error = caught instanceof Error ? caught.message : "Could not load settings overview";
	} finally {
		if (id === loadId) loading = false;
	}
}
$effect(() => {
	const type = scopeType;
	void refreshVersion;
	if (!type) return;
	loading = true;
	void reload();
});
onMount(() => {
	const unsubscribe = onSettingsChanged(() => {
		void reload();
	});
	return () => {
		loadId++;
		unsubscribe();
	};
});
function repositoryLabel(label: string) {
	return label.split(" · ")[0];
}
function repositoryHref(choice: SettingChoice): string | undefined {
	try {
		const value = JSON.parse(choice.value);
		if (typeof value.origin !== "string" || typeof value.projectId !== "number") return;
		const url = new URL(value.origin);
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return;
		url.pathname = `/projects/${value.projectId}`;
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return;
	}
}
async function close() {
	onClose();
	await tick();
	(
		document.getElementById(`settings-row-${selected}`) ??
		document.getElementById("settings-search")
	)?.focus();
}
</script>

<div class="settings-overview" class:editing={panelOpen}>
<div class="overview-header"><div><h2>{label}</h2><p aria-live="polite">{#if loading}Loading overview…{:else if error}Overview unavailable{:else if mapping}{projectRows.filter((row) => status(row) === "mapped").length} of {projectRows.length} {overview?.itemLabelPlural.toLowerCase() ?? "entries"} mapped · {projectRows.filter((row) => status(row) === "unmapped").length} unmapped{:else}{projectRows.length} {label.toLowerCase()} · {projectRows.filter((row) => status(row) === "customized").length} customized{/if}{#if projectRows.some((row) => status(row) === "error")} · {projectRows.filter((row) => status(row) === "error").length} need attention{/if}</p></div>{@render refresh?.()}</div>
{#if error}<div class="overview-error" role="alert">{error} <button type="button" onclick={reload}>Retry overview</button></div>{/if}
<div class="toolbar"><div class="search"><label for="settings-search">Search {overview?.itemLabelPlural.toLowerCase() ?? "entries"}</label><input id="settings-search" type="search" placeholder={mapping ? "Search components or repositories…" : "Search repositories or settings…"} value={query} oninput={(event) => update("q", event.currentTarget.value, true)} /></div>{#if projects.length}<div class="project"><label for="settings-project">{overview?.parentLabel ?? "Group"}</label><select id="settings-project" value={project} onchange={(event) => update("project", event.currentTarget.value)}><option value="">All {(overview?.parentLabel ?? "group").toLowerCase()}s</option>{#each projects as name}<option value={name}>{name}</option>{/each}</select></div>{/if}</div>
<div class="filters" role="group" aria-label="Filter settings">{#each filters as option}<button type="button" aria-pressed={filter === option.id} onclick={() => update("filter", option.id)}>{option.label} <span>{option.id === "all" ? projectRows.length : projectRows.filter((row) => status(row) === option.id).length}</span></button>{/each}</div>
<div class="overview-layout" class:panel-open={panelOpen}>
 <div class="inventory">
  <table><caption class="sr-only">{label} settings overview</caption><thead><tr><th scope="col">{overview?.itemLabel ?? "Name"}</th><th scope="col">Status</th><th scope="col">{mapping ? "Repositories" : "Settings"}</th></tr></thead><tbody>
  {#each visibleRows as row (row.id)}<tr class:selected={panelOpen && row.id === selected}><th scope="row"><button type="button" id={`settings-row-${row.id}`} aria-expanded={panelOpen && row.id === selected} aria-controls={panelOpen ? "settings-editor" : undefined} onclick={() => onSelect(row.id)}>{row.name}</button>{#if row.project}<small>{row.project}</small>{/if}{#if !row.active}<small>Inactive scope</small>{/if}</th><td><span class="status" class:mapped={status(row) === "mapped"} class:attention={status(row) === "error"}>{status(row) === "loading" ? "Loading…" : status(row) === "error" ? "Needs attention" : status(row) === "mapped" ? "Mapped" : status(row) === "unmapped" ? "Unmapped" : status(row) === "customized" ? "Customized" : status(row) === "unavailable" ? "Unavailable" : "Using defaults"}</span></td><td>{#if row.summary?.mapping?.length}{@const choice = row.summary.mapping[0]}{@const href = repositoryHref(choice)}{#if href}<a class="repository" {href} target="_blank" rel="noopener noreferrer" aria-label={`${repositoryLabel(choice.label)} (opens in a new tab)`} title={row.summary.mapping.map((entry) => entry.label).join("; ")}>{repositoryLabel(choice.label)}</a>{:else}<span class="repository">{repositoryLabel(choice.label)}</span>{/if}{#if row.summary.mapping.length > 1}<span class="more">+{row.summary.mapping.length - 1} more</span>{/if}{:else if row.summary?.errors.length}<span class="muted">Open to review</span>{:else if row.summary?.mapping !== undefined}<span class="muted">No repository selected</span>{:else if row.summary?.customized.length}<span>{row.summary.customized.join(", ")}</span>{:else}<span class="muted">{mapping ? "No repository selected" : "Inherited settings"}</span>{/if}</td></tr>{/each}
  </tbody></table>
  {#if !visibleRows.length && !loading}<div class="empty"><h3>{query || filter !== "all" || project ? "No matching entries" : "No entries yet"}</h3><p>{query || filter !== "all" || project ? "Change your search or filters to see more entries." : "Refresh sources to discover settings scopes."}</p></div>{/if}
 </div>
 {#if panelOpen}<aside id="settings-editor" aria-label="Settings editor"><div class="editor-heading"><div><h3 tabindex="-1" id="settings-editor-heading">{rows.find((row) => row.id === selected)?.name ?? "Settings"}</h3><p>{rows.find((row) => row.id === selected)?.project || label}</p></div><button type="button" onclick={close}>Close</button></div>{#if mapping && nextUnmapped}<button class="next" type="button" onclick={() => onSelect(nextUnmapped.id)}>Next unmapped {overview?.itemLabel.toLowerCase() ?? "entry"}</button>{/if}{@render children?.()}</aside>{/if}
</div>

</div>

<style>
h2 { margin: 0; font-size: var(--type-title-sm); }
h3 { margin: 0; font-size: var(--type-body-lg); overflow-wrap: anywhere; }
p { margin: .5rem 0 0; color: var(--chronicle-text-muted); line-height: 1.5; }
.overview-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin: 1.75rem 0 1.25rem; }
.toolbar { display: flex; gap: 1rem; align-items: end; }
.search { flex: 1; }
.project { min-width: 140px; }
label { display: block; margin-bottom: .5rem; font-size: var(--type-body-sm); font-weight: 600; }
input, select, button { min-height: 44px; padding: .65rem .8rem; border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-sm); background: var(--chronicle-panel-surface); color: var(--chronicle-text); font: inherit; }
input, select { width: 100%; min-width: 0; }
button { cursor: pointer; }
button:hover { background: var(--chronicle-panel-muted); }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 3px; }
.filters { display: flex; flex-wrap: wrap; gap: .35rem; margin: 1rem 0; }
.filters button { border-color: transparent; background: transparent; font-size: var(--type-body-sm); }
.filters button[aria-pressed="true"] { background: var(--chronicle-accent-soft); color: var(--chronicle-accent); font-weight: 600; }
.filters span { margin-left: .5rem; font-variant-numeric: tabular-nums; }
.overview-layout { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; border-top: 1px solid var(--chronicle-border); }
.overview-layout.panel-open { grid-template-columns: minmax(0, 1fr) minmax(320px, .85fr); }
.inventory { min-width: 0; }
table { width: 100%; border-collapse: collapse; text-align: left; table-layout: fixed; font-size: var(--type-body-sm); }
th, td { padding: .85rem .75rem; border-bottom: 1px solid var(--chronicle-border); vertical-align: top; overflow-wrap: anywhere; }
thead th { font-weight: 600; color: var(--chronicle-text-muted); background: var(--chronicle-panel-muted); }
th:first-child { width: 35%; }
th:nth-child(2) { width: 24%; }
tbody th { font-weight: 400; }
tbody th button { min-height: 44px; margin: -.5rem 0; padding: .5rem 0; border: 0; background: transparent; border-radius: 0; color: var(--chronicle-link); text-align: left; font-weight: 600; overflow-wrap: anywhere; }
tbody tr:hover { background: var(--chronicle-panel-muted); }
tr.selected { background: var(--chronicle-accent-soft); }
small { display: block; margin-top: .25rem; color: var(--chronicle-text-muted); }
.status { white-space: normal; color: var(--chronicle-text-muted); }
.status.mapped { color: var(--chronicle-success); }
.status.attention, .overview-error { color: var(--chronicle-danger); }
.repository { display: block; }
a.repository { color: var(--chronicle-link); text-underline-offset: .2em; }
a.repository:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 3px; }
.more, .muted { color: var(--chronicle-text-muted); }
.more { display: inline-block; margin-top: .25rem; }
aside { position: sticky; top: 1rem; min-width: 0; max-height: calc(100dvh - 2rem); overflow-y: auto; padding: 1.25rem; border-left: 1px solid var(--chronicle-border); }
.editor-heading { display: flex; justify-content: space-between; align-items: start; gap: 1rem; }
.editor-heading p { font-size: var(--type-caption); }
.next { margin-top: 1rem; width: 100%; }
.empty { padding: 2rem 1rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 1000px) { .panel-open th:first-child { width: 52%; } .panel-open th:nth-child(2) { width: 48%; } .panel-open th:nth-child(3), .panel-open td:nth-child(3) { display: none; } }
@media (max-width: 700px) { .editing .overview-header, .editing .toolbar, .editing .filters { display: none; } .toolbar { flex-direction: column; align-items: stretch; } .overview-header { align-items: start; } .overview-layout.panel-open { grid-template-columns: minmax(0, 1fr); } .panel-open .inventory { display: none; } aside { position: static; max-height: none; border-left: 0; padding: 1rem 0; } th:first-child { width: 46%; } th:nth-child(2) { width: 26%; } }
</style>

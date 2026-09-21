<script lang="ts">
import {
	Background,
	Controls,
	type Edge,
	MarkerType,
	MiniMap,
	type Node,
	SvelteFlow,
} from "@xyflow/svelte";
import { onMount, tick, untrack } from "svelte";
import ApiCard from "./ApiCard.svelte";
import {
	type Assessment,
	assessmentLabels,
	type Candidate,
	type Constraint,
	constraintLabels,
	removalCandidates,
} from "./candidates";
import FlowActions from "./FlowActions.svelte";
import { filterFindings, findingsExportParts } from "./findings-export";
import { buildGraph, graphChildren, type View } from "./graph";
import InternalDependencies from "./InternalDependencies.svelte";
import { createLayout } from "./layout";
import {
	type Filters,
	indexSnapshot,
	isApi,
	matches,
	type Occurrence,
	type Snapshot,
	type UsageEvidence,
	usageInfo,
	usageMode,
	usageScope,
} from "./model";
import { dismissNote, focusNote } from "./note-editor";
import {
	clearNotes,
	makeNote,
	markdownExport,
	mergeNotes,
	type Note,
	type NoteClearUndo,
	parseBackup,
	storageKey,
	undoNoteClear,
} from "./notes";
import { sectionForHash, sectionLinks } from "./sections";

let snapshot = $state.raw<Snapshot | null>(null);
let candidateQuery = $state("");
let candidateCategory = $state<Candidate["action"] | "">("");
let candidateAssessment = $state<Assessment | "">("");
let candidateConstraint = $state<Constraint["code"] | "">("");
let candidateScope = $state("");
const candidateFilters = $derived({
	query: candidateQuery,
	category: candidateCategory,
	assessment: candidateAssessment,
	constraint: candidateConstraint,
	scope: candidateScope,
});
let candidateLimit = $state(60);
let candidateSort = $state<"action" | "name">("action");
const candidates = $derived(
	snapshot
		? removalCandidates(snapshot).sort((a, b) =>
				candidateSort === "action"
					? a.action.localeCompare(b.action) || a.node.label.localeCompare(b.node.label)
					: a.node.label.localeCompare(b.node.label),
			)
		: [],
);

const candidateScopes = $derived([...new Set(candidates.flatMap((f) => f.observedUsage))].sort());
const candidateCategories = $derived(
	[...new Set(candidates.map((f) => f.action))].sort().map((action) => ({
		action,
		count: candidates.filter((f) => f.action === action).length,
	})),
);
const shownCandidates = $derived(filterFindings(candidates, candidateFilters));
function resetCandidateFilters() {
	candidateQuery = "";
	candidateCategory = "";
	candidateAssessment = "";
	candidateConstraint = "";
	candidateScope = "";
	candidateLimit = 60;
}
function exportFindings() {
	if (!snapshot) return;
	try {
		const parts = findingsExportParts(snapshot, shownCandidates, candidateFilters);
		download("api-removal-candidates.json", new Blob(parts, { type: "application/json" }));
	} catch (e) {
		error = `Could not export findings: ${String(e)}. Narrow the category or search and try again.`;
	}
}
function inspectCandidate(id: string) {
	inspect(id);
	if (window.innerWidth <= 900)
		document.querySelector(".inspector")?.scrollIntoView({ behavior: "smooth" });
}
let loading = $state(true),
	error = $state(""),
	status = $state(""),
	selectedId = $state("");
let filters = $state<Filters>({
	query: "",
	package: "",
	public: true,
	internal: true,
	kind: "",
	tests: false,
	internalUsages: false,
});
let view = $state<View>({ root: "", limits: {}, expanded: [], hidden: [], siteLimits: {} });
let history = $state<View[]>([]),
	future = $state<View[]>([]);
let sectionHash = $state(window.location.hash);
const mode = $derived(sectionForHash(sectionHash));
let noteQuery = $state("");
let editingNoteId = $state("");
let inspectorNoteEditing = $state(false);
let noteUndo = $state.raw<NoteClearUndo | null>(null);
let notes = $state<Record<string, Note>>({}),
	saveStatus = $state("Saved locally"),
	storageFailure = $state("");
let storageBlocked = false;
let nodes = $state.raw<Node[]>([]),
	edges = $state.raw<Edge[]>([]);
let occurrence = $state<Occurrence | null>(null),
	occurrenceKind = $state(""),
	usageLimit = $state(30),
	searchLimit = $state(60);
let evidenceSource = $state.raw<UsageEvidence | null>(null),
	evidenceLimit = $state(8);
let showCoverage = $state(false),
	layoutBusy = $state(false);
// Position cache is deliberately nonreactive; explicit layout and Flow own updates.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const positions = new Map<string, { x: number; y: number }>();
let renderedRoot = "";
const laidOutViews: string[] = [];
const positionKey = (root: string, id: string) => `${root}\0${id}`;
let layouter: ReturnType<typeof createLayout>,
	request = 0,
	fitCanvas = () => {};
let layoutOnUpdate = $state(true);
const layoutNodes = $derived(
	nodes.flatMap((node) => {
		const width = node.measured?.width,
			height = node.measured?.height;
		return width && height ? [{ id: node.id, width, height }] : [];
	}),
);
const layoutReady = $derived(nodes.length > 0 && layoutNodes.length === nodes.length);
const index = $derived(snapshot ? indexSnapshot(snapshot) : null);
const graph = $derived(snapshot && index ? buildGraph(snapshot, index, view, filters) : null);
const selected = $derived(index?.byId.get(selectedId));
const selectedUsageInfo = $derived(
	selected && index && isApi(selected)
		? usageInfo(
				selected,
				index,
				mode === "candidates"
					? (candidates.find((f) => f.id === selectedId)?.usages.length ?? 0)
					: (graph?.occurrencesFor(selected).length ?? 0),
			)
		: null,
);
const selectedEvidence = $derived(
	(selected?.evidence ?? []).filter(
		(item) => mode === "candidates" || filters.tests || !item.isTest,
	),
);
const hasNotes = $derived(Object.values(notes).some((note) => note.text.length > 0));
const packages = $derived(snapshot?.nodes.filter((n) => n.kind === "package") ?? []);
const kinds = $derived([...new Set(snapshot?.nodes.filter(isApi).map((n) => n.kind) ?? [])].sort());
const searching = $derived(Boolean(filters.query || filters.kind));
const results = $derived(
	snapshot?.nodes.filter(
		(n) =>
			matches(n, filters) &&
			(searching ? n.kind !== "file" && n.kind !== "entry" : n.kind === "package"),
	) ?? [],
);
const breadcrumbs = $derived.by(() => {
	const list = [];
	let current = index?.byId.get(view.root);
	while (current) {
		if (current.kind !== "entry") list.unshift(current);
		current = index?.byId.get(current.parentId ?? "");
	}
	return list;
});
const focusNode = $derived(index?.byId.get(view.root));
const selectedUsages = $derived(
	(mode === "candidates"
		? (candidates
				.find((f) => f.id === selectedId)
				?.usages.concat(candidates.find((f) => f.id === selectedId)?.cleanup ?? []) ?? [])
		: selected?.kind === "file"
			? (graph?.fileOccurrences.get(selected.id) ?? index?.fileUsages.get(selected.id))
			: selected
				? [
						...(usageMode(selected) === "usages"
							? []
							: (index?.usages.get(selectedId) ?? [])
						).filter((o) => o.kind !== "call"),
						...(graph?.occurrencesFor(selected) ?? []),
					].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column)
				: []
	)?.filter(
		(o) =>
			(mode === "candidates" || filters.tests || !o.isTest) &&
			(!occurrenceKind || o.kind === occurrenceKind) &&
			(selected?.kind !== "file" ||
				graph?.fileOccurrences.has(selected.id) ||
				!focusNode ||
				!isApi(focusNode) ||
				o.targets.includes(view.root)),
	) ?? [],
);
const noteList = $derived(
	Object.values(notes)
		.filter(
			(n) =>
				n.nodeId === editingNoteId ||
				(n.text.trim() &&
					`${n.text} ${n.context.label} ${n.context.package}`
						.toLowerCase()
						.includes(noteQuery.toLowerCase())),
		)
		.sort(
			(a, b) =>
				a.context.package.localeCompare(b.context.package) || a.nodeId.localeCompare(b.nodeId),
		),
);

async function reload() {
	loading = true;
	error = "";
	try {
		const response = await fetch(`/api/reports?t=${Date.now()}`, { cache: "no-store" });
		if (!response.ok)
			throw new Error(
				"Cannot load reports. Start the explorer with npm run dev, then Reload reports.",
			);
		const next = (await response.json()) as Snapshot;
		if (
			next.version !== 1 ||
			!Array.isArray(next.nodes) ||
			!Array.isArray(next.occurrences) ||
			!next.repository?.id
		)
			throw new Error("Unsupported snapshot. Regenerate it with this version of the tool.");
		if (snapshot?.repository.id !== next.repository.id) {
			notes = {};
			noteUndo = null;
			storageBlocked = false;
			try {
				const stored = localStorage.getItem(storageKey(next.repository.id));
				notes = stored ? parseBackup(stored, next.repository.id).notes : {};
				storageFailure = "";
			} catch (e) {
				storageBlocked = true;
				saveStatus = "Not saved";
				storageFailure = `Could not load notes: ${String(e)}. Export a backup before clearing browser storage.`;
			}
		}
		snapshot = next;
		if (!next.nodes.length) showCoverage = true;
		evidenceSource = null;
		occurrence = null;
		if (view.root && !next.nodes.some((n) => n.id === view.root))
			view = { root: "", limits: {}, expanded: [], hidden: [], siteLimits: {} };
		status = "Snapshot loaded";
		layoutOnUpdate = nodes.length === 0;
	} catch (e) {
		error = String(e);
	} finally {
		loading = false;
	}
}
function persist() {
	if (!snapshot || storageBlocked) return;
	try {
		localStorage.setItem(
			storageKey(snapshot.repository.id),
			JSON.stringify({ version: 1, repositoryId: snapshot.repository.id, notes }),
		);
		saveStatus = "Saved locally";
		storageFailure = "";
	} catch (e) {
		saveStatus = "Not saved";
		storageFailure = `Browser storage failed: ${String(e)}. Export JSON to keep your notes.`;
	}
}
function save(id: string, text: string) {
	const node = index?.byId.get(id);
	if (!node && !notes[id]) return;
	notes = {
		...notes,
		[id]: node
			? makeNote(node, text)
			: { ...notes[id], text, modifiedAt: new Date().toISOString() },
	};
	persist();
}
function clear(id?: string) {
	const result = clearNotes(notes, id ? [id] : undefined);
	if (!Object.keys(result.undo.previous).length) return;
	notes = result.notes;
	noteUndo = result.undo;
	editingNoteId = "";
	inspectorNoteEditing = false;
	persist();
	status = id ? "Note cleared" : "All notes cleared";
}
function undoClear() {
	if (!noteUndo) return;
	notes = undoNoteClear(notes, noteUndo);
	noteUndo = null;
	persist();
	status = "Clear undone; newer edits kept";
}
function inspect(id: string) {
	if (id !== selectedId) {
		inspectorNoteEditing = false;
		occurrenceKind = "";
	}
	selectedId = id;
	if (graph?.fileOccurrences.has(id))
		occurrenceKind = graph.fileModes.get(id) === "calls" ? "call" : "";
	occurrence = null;
	evidenceSource = null;
	evidenceLimit = 8;
	usageLimit = 30;
}
function open(id: string) {
	const target = index?.byId.get(id);
	if (target?.kind === "entry") id = target.parentId ?? "";
	history = [...history, structuredClone($state.snapshot(view))];
	future = [];
	view = { root: id, limits: {}, expanded: [], hidden: [], siteLimits: {} };
	window.location.hash = sectionLinks.graph;
	inspect(id);
	layoutOnUpdate = !laidOutViews.includes(id);
	request++;
	layoutBusy = false;
	if (!layoutOnUpdate) setTimeout(() => fitCanvas(), 80);
}
function navigate(back: boolean) {
	request++;
	layoutBusy = false;
	const source = back ? history : future;
	if (!source.length) return;
	const current = structuredClone($state.snapshot(view));
	if (back) {
		future = [...future, current];
		view = history[history.length - 1];
		history = history.slice(0, -1);
	} else {
		history = [...history, current];
		view = future[future.length - 1];
		future = future.slice(0, -1);
	}
	inspect(view.root);
	window.location.hash = sectionLinks.graph;
	setTimeout(() => fitCanvas(), 50);
}
function expand(id: string) {
	if (id === view.root) {
		view = { ...view, limits: { ...view.limits, [id]: view.limits[id] === 0 ? 6 : 0 } };
		return;
	}
	view = {
		...view,
		expanded: view.expanded.includes(id)
			? view.expanded.filter((n) => n !== id)
			: [...view.expanded, id],
	};
}
function toggleSites(id: string) {
	const siteLimits = { ...view.siteLimits };
	if (siteLimits[id] !== undefined) delete siteLimits[id];
	else siteLimits[id] = 6;
	view = { ...view, siteLimits };
	setTimeout(() => fitCanvas(), 100);
}
function moreSitesClick(id: string) {
	view = { ...view, siteLimits: { ...view.siteLimits, [id]: (view.siteLimits?.[id] ?? 6) + 6 } };
	setTimeout(() => fitCanvas(), 100);
}
function hide(id: string) {
	view = { ...view, hidden: [...view.hidden, id] };
}
function moreClick(id: string) {
	view = {
		...view,
		limits: { ...view.limits, [id]: (view.limits[id] ?? (id === "overview" ? 8 : 6)) + 12 },
	};
}
async function layout() {
	if (!layouter || !layoutReady) return;
	layoutBusy = true;
	const ticket = ++request,
		root = view.root,
		ids = nodes.map((n) => n.id).join("\0");
	try {
		const result = await layouter.run(
			layoutNodes,
			edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
			!root,
		);
		if (ticket !== request || root !== view.root || ids !== nodes.map((n) => n.id).join("\0"))
			return;
		for (const [id, position] of result) positions.set(positionKey(root, id), position);
		nodes = nodes.map((n) => ({ ...n, position: result.get(n.id) ?? n.position }));
		if (!laidOutViews.includes(root)) laidOutViews.push(root);
		await tick();
		if (ticket === request) fitCanvas();
	} catch (e) {
		error = `Layout failed: ${String(e)}. You can still arrange nodes manually.`;
	} finally {
		if (ticket === request) layoutBusy = false;
	}
}

function download(name: string, content: string | Blob, type?: string) {
	const url = URL.createObjectURL(
		content instanceof Blob ? content : new Blob([content], { type }),
	);
	const link = document.createElement("a");
	try {
		link.href = url;
		link.download = name;
		document.body.append(link);
		link.click();
		status = `Download requested: ${name}. Check your browser downloads.`;
	} finally {
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}
}
function backup() {
	if (snapshot)
		download(
			"leitwerk-api-notes.json",
			JSON.stringify({ version: 1, repositoryId: snapshot.repository.id, notes }, null, 2),
			"application/json",
		);
}
async function importNotes(event: Event) {
	const input = event.currentTarget as HTMLInputElement,
		file = input.files?.[0];
	if (!file || !snapshot) return;
	try {
		const incoming = parseBackup(await file.text(), snapshot.repository.id);
		notes = mergeNotes(notes, incoming.notes);
		storageBlocked = false;
		persist();
		status = "Backup merged. Newer notes kept; current notes win ties.";
	} catch (e) {
		error = String(e);
	} finally {
		input.value = "";
	}
}
async function copyLocation() {
	const source = occurrence ?? evidenceSource?.source ?? selected?.source;
	if (!source) return;
	try {
		await navigator.clipboard.writeText(`${source.path}:${source.line}`);
		status = "Copied source location";
	} catch {
		status = "Clipboard unavailable. Select the source location to copy it.";
	}
}
onMount(() => {
	layouter = createLayout();
	void reload();
	return () => layouter.close();
});

$effect(() => {
	const next = graph;
	if (!next) return;
	untrack(() => {
		// Keep manual positions, except when adding packages to the overview.
		for (const n of nodes) positions.set(positionKey(renderedRoot, n.id), n.position);
		const previousNodes = new Map(nodes.map((node) => [node.id, node]));
		if (
			!view.root &&
			renderedRoot === view.root &&
			next.nodes.some((node) => node.kind === "package" && !previousNodes.has(node.id))
		) {
			request++;
			layoutBusy = false;
			layoutOnUpdate = true;
		}
		renderedRoot = view.root;
		const occupied = next.nodes.flatMap((item) => {
			const position = positions.get(positionKey(view.root, item.id));
			const old = previousNodes.get(item.id);
			return position ? [{ ...position, height: old?.measured?.height ?? 180 }] : [];
		});
		const positionFor = (item: import("./model").ApiNode, order: number) => {
			const key = positionKey(view.root, item.id),
				saved = positions.get(key);
			if (saved) return saved;
			const edge = next.edges.find((e) =>
				item.kind === "file" ? e.source === item.id : e.target === item.id,
			);
			const parent =
				edge &&
				positions.get(positionKey(view.root, item.kind === "file" ? edge.target : edge.source));
			const position = parent
				? { x: parent.x + (item.kind === "file" ? -352 : 352), y: parent.y }
				: { x: Math.floor(order / 4) * 360, y: (order % 4) * 210 };
			while (true) {
				const collision = occupied.find(
					(p) =>
						Math.abs(p.x - position.x) < 288 &&
						position.y < p.y + p.height + 28 &&
						position.y + 180 > p.y - 28,
				);
				if (!collision) break;
				position.y = collision.y + collision.height + 36;
			}
			positions.set(key, position);
			occupied.push({ ...position, height: 180 });
			return position;
		};
		nodes = next.nodes.map((item, i) => ({
			id: item.id,
			type: "api",
			measured: previousNodes.get(item.id)?.measured,
			position: positionFor(item, i),
			selected: item.id === selectedId,
			data: {
				item,
				noteFor: (id: string) => notes[id]?.text ?? "",
				saveStatus: () => saveStatus,
				inspect,
				open,
				expand,
				hide,
				save,
				clear,
				moreClick,
				more: next.more[item.id] ?? 0,
				toggleSites,
				moreSitesClick,
				siteCount: next.siteCounts[item.id] ?? 0,
				siteMode: next.fileModes.get(item.id) ?? usageMode(item),
				usageScope: next.fileScopes.get(item.id),
				usageHint:
					isApi(item) && !next.siteCounts[item.id] && index ? usageInfo(item, index, 0) : undefined,
				sitesVisible: view.siteLimits?.[item.id] !== undefined,
				moreSites: next.moreSites[item.id] ?? 0,
				expanded:
					view.expanded.includes(item.id) || (item.id === view.root && view.limits[item.id] !== 0),
			},
		}));
		edges = next.edges.map((e) => ({
			...e,
			type: "default",
			style:
				e.usageScope === "internal"
					? "stroke: #aeb6c0; stroke-width: 1.1; stroke-dasharray: 5 4"
					: e.usageScope === "external"
						? "stroke: #668b96; stroke-width: 1.4"
						: "stroke: #b4bdc8; stroke-width: 1.1",
			labelStyle: "fill: #536174; font-size: 11px",
			labelBgStyle: "fill: #f7f8fa",
			markerEnd: { type: MarkerType.ArrowClosed, color: "#9baec9", width: 14, height: 14 },
			ariaLabel: `${index?.byId.get(e.source)?.label} to ${index?.byId.get(e.target)?.label}: ${e.label}`,
		}));
	});
});

$effect(() => {
	if (layoutOnUpdate && layoutReady) {
		layoutOnUpdate = false;
		untrack(() => void layout());
	}
});
</script>

<svelte:window onhashchange={() => sectionHash = window.location.hash} />
<svelte:head><title>API explorer · Leitwerk</title></svelte:head>
<div class="app">
  <header>
    <div class="brand"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4v16h14M10 4v11h9M15 4v6h4"/></svg><strong>Leitwerk</strong><span class="divider"></span><h1>API explorer</h1><span class="prototype">Prototype</span></div>
    <nav class="header-actions" aria-label="Explorer views"><a class="button-link" class:active={mode==='graph'} aria-current={mode==='graph'?'page':undefined} href={sectionLinks.graph}>Explorer</a><a class="button-link" class:active={mode==='candidates'} aria-current={mode==='candidates'?'page':undefined} href={sectionLinks.candidates}>Removal candidates</a><a class="button-link" class:active={mode==='dependencies'} aria-current={mode==='dependencies'?'page':undefined} href={sectionLinks.dependencies}>Internal API dependencies</a><a class="button-link" class:active={mode==='notes'} aria-current={mode==='notes'?'page':undefined} href={sectionLinks.notes}>All notes <span class="count">{Object.values(notes).filter(n=>n.text.trim()).length}</span></a><button disabled={loading} onclick={reload}>{loading?'Loading…':'Reload reports'}</button></nav>
  </header>
  {#if error}<div class="banner error" role="alert">{error}<button onclick={()=>error=''}>Dismiss</button></div>{/if}
  {#if storageFailure}<div class="banner error" role="alert">{storageFailure}<button onclick={backup}>Export backup</button></div>{/if}
  {#if snapshot}
    <div class="workbench" class:candidate-mode={mode==='candidates'} class:dependency-mode={mode==='dependencies'}>
      <aside class="navigation" aria-label="API navigation">
        <div class="navigation-top"><h2>Repository</h2><button onclick={()=>open('')}>Overview</button></div>
        <label class="search-label">Find an API<input type="search" placeholder="Search names, packages…" bind:value={filters.query} oninput={()=>searchLimit=60}/></label>
        <label>Package<select bind:value={filters.package}><option value="">All packages</option>{#each packages as pkg (pkg.id)}<option value={pkg.package}>{pkg.label.replace('@leitwerk-dev/','')}</option>{/each}</select></label>
        <div class="filter-row"><label><input type="checkbox" bind:checked={filters.public}/><span class="visibility-swatch public" aria-hidden="true"></span>Public / preview</label><label><input type="checkbox" bind:checked={filters.internal}/><span class="visibility-swatch internal" aria-hidden="true"></span>Internal</label></div>
        <div class="filter-row"><label><input type="checkbox" bind:checked={filters.tests} onchange={()=>{evidenceSource=null;occurrence=null;}}/>Include tests</label><select aria-label="Declaration kind" bind:value={filters.kind}><option value="">All kinds</option>{#each kinds as kind (kind)}<option>{kind}</option>{/each}</select></div>
        <div class="filter-row"><label title="Include same-package callers and interface usages. Package boxes always show external callers only."><input type="checkbox" bind:checked={filters.internalUsages} onchange={()=>{occurrence=null;setTimeout(()=>fitCanvas(),100);}}/>Include internal usages</label></div>
        <div class="list-heading"><span>{searching?'Search results':'Packages'}</span><span>{results.length}</span></div>
        <nav class="navigation-list" aria-label="Packages and declarations">
          {#each results.slice(0,searchLimit) as item (item.id)}<button class:active={selectedId===item.id} onclick={()=>open(item.id)}><span class="nav-label">{item.label.replace('@leitwerk-dev/','')}</span><small>{searching?`${item.kind} · ${item.package.replace('@leitwerk-dev/','')}`:item.group}</small></button>{/each}
          {#if !results.length}<p class="empty">No matches. Try another name or widen the filters.</p>{/if}
          {#if results.length>searchLimit}<button onclick={()=>searchLimit+=60}>Show more ({results.length-searchLimit})</button>{/if}
        </nav>
        <div class="navigation-footer">{snapshot.nodes.filter(isApi).length.toLocaleString()} declarations & members<br/>{snapshot.coverage.sourceFiles.toLocaleString()} TS / JS / Svelte files indexed</div>
      </aside>
      <main>
        {#if mode==='dependencies'}
          <InternalDependencies {snapshot} {open}/>
        {:else if mode==='candidates'}
          <div class="notes-page candidates-page">
            <div class="page-heading"><div><h2>Removal candidates</h2><p>Evidence from the loaded sources. Findings use every report, independently of Explorer filters.</p></div><button disabled={!shownCandidates.length} onclick={exportFindings}>Export findings ({shownCandidates.length})</button></div>
            <p>{snapshot.reports?.length ?? 0} sources loaded · {candidates.length} findings. Recommendations require review; unobserved consumers may exist.</p>
            <div class="candidate-filters">
            <label>Find a candidate<input type="search" placeholder="Name, package, or proposed action…" bind:value={candidateQuery} oninput={()=>candidateLimit=60}/></label>
            <label>Proposed change<select bind:value={candidateCategory} onchange={()=>candidateLimit=60}><option value="">All changes ({candidates.length})</option>{#each candidateCategories as category (category.action)}<option value={category.action}>{category.action} ({category.count})</option>{/each}</select></label>
            <label>Assessment<select bind:value={candidateAssessment} onchange={()=>candidateLimit=60}><option value="">All assessments</option>{#each Object.entries(assessmentLabels) as [code, label] (code)}<option value={code}>{label} ({candidates.filter(f=>f.assessment===code).length})</option>{/each}</select></label>
            <label>Constraint<select bind:value={candidateConstraint} onchange={()=>candidateLimit=60}><option value="">All constraints</option>{#each Object.entries(constraintLabels) as [code, label] (code)}<option value={code}>{label} ({candidates.filter(f=>f.constraints.some(c=>c.code===code)).length})</option>{/each}</select></label>
            <label>Observed usage<select bind:value={candidateScope} onchange={()=>candidateLimit=60}><option value="">All observed usage</option>{#each candidateScopes as scope (scope)}<option value={scope}>{scope.replaceAll('-', ' ')}</option>{/each}</select></label>
            <label>Sort findings<select bind:value={candidateSort}><option value="action">Proposed change</option><option value="name">Declaration name</option></select></label>
            </div>
            <p>For model access, use the <a href="/api/v1/schema" target="_blank" rel="noreferrer">read-only findings API</a>. No notes or source files are changed.</p>
            <p class="candidate-summary" role="status">{shownCandidates.length} of {candidates.length} findings match. Export includes all matches, including rows not yet shown.</p>
            {#if candidateQuery || candidateCategory || candidateAssessment || candidateConstraint || candidateScope}<button onclick={resetCandidateFilters}>Clear findings filters</button>{/if}
            <div class="candidate-table-wrap"><table class="candidate-table"><thead><tr><th>Declaration</th><th>Proposed change / assessment</th><th>Observed usage</th><th>Export routes / reports</th></tr></thead><tbody>
            {#each shownCandidates.slice(0,candidateLimit) as finding (finding.id)}<tr><td><button onclick={()=>inspectCandidate(finding.id)}>{finding.node.label}</button><small>{finding.node.package}</small><button onclick={()=>open(finding.id)}>Explore / notes</button></td><td><strong>{finding.action}</strong><p>{assessmentLabels[finding.assessment]}</p><small>Declaration: {assessmentLabels[finding.declarationAssessment]}</small><details><summary>Evidence and constraints ({finding.constraints.length})</summary>{#if !finding.constraints.length}<p>{finding.reason}</p>{/if}{#each finding.constraints as constraint, i (`${constraint.code}:${constraint.appliesTo}:${constraint.routeId ?? ''}:${i}`)}<p><strong>{constraintLabels[constraint.code]}</strong> · {constraint.appliesTo}{constraint.routeId ? ` · ${constraint.routeId}` : ''}<br/>{constraint.detail}</p>{/each}{#each finding.retainingApiIds as ownerId (ownerId)}<button disabled={!index?.byId.has(ownerId)} onclick={()=>open(ownerId)}>Retaining API: {snapshot.nodes.find(n=>n.id===ownerId)?.qualifiedName ?? snapshot.nodes.find(n=>n.id===ownerId)?.label ?? ownerId}</button>{/each}</details><small>{finding.compatibility}</small></td><td>{finding.observedUsage.map(scope=>scope.replaceAll('-', ' ')).join(', ')}<small>{finding.usages.length} references · {finding.cleanup.length} import / exposure dependencies</small></td><td>{#each finding.routes as route (route.id)}<div>{route.entry} · {assessmentLabels[route.assessment]}{route.testUsed ? (route.productionUsed ? ' · production + tests' : ' · tests') : route.productionUsed ? ' · production' : ''}{#if route.migrationRequirements.length}<details><summary>Migration requirements ({route.migrationRequirements.length})</summary>{#each route.migrationRequirements as migration (migration.code)}<p>{migration.detail} <small>{migration.occurrenceIds.length} affected references</small></p>{/each}</details>{/if}</div>{/each}<small>{finding.reports.map(id=>snapshot?.reports?.find(r=>r.id===id)?.name ?? id).join(', ')}</small></td></tr>{/each}
            </tbody></table></div>
            <p>{Math.min(shownCandidates.length,candidateLimit)} of {shownCandidates.length} matching findings</p>
            {#if shownCandidates.length > candidateLimit}<button onclick={()=>candidateLimit+=60}>Show more findings</button>{/if}
            {#if candidates.length && !shownCandidates.length}<p class="empty">No findings match these filters. Choose another category or clear the search.</p>{/if}
            {#if !candidates.length}<p class="empty">No findings. Generate a catalog with npm run api:report and reload reports.</p>{/if}
          </div>
        {:else if mode==='notes'}
          <div class="notes-page">
            <div class="page-heading"><div><h2>All notes</h2><p>Saved in this browser. Export a backup to keep a portable copy.</p></div><div class="toolbar"><button onclick={()=>snapshot&&download('leitwerk-api-notes.md',markdownExport(notes,snapshot),'text/markdown')}>Export Markdown</button><button onclick={backup}>Export JSON</button><label class="file-button">Import JSON<input type="file" accept=".json,application/json" onchange={importNotes}/></label><button disabled={!hasNotes} title="Clear every note, including hidden and absent nodes" onclick={()=>clear()}>Clear all</button>{#if noteUndo}<button onclick={undoClear}>Undo</button>{/if}</div></div>
            <input class="notes-search" aria-label="Search notes" type="search" placeholder="Search notes and API names…" bind:value={noteQuery}/>
            {#each noteList as note (note.nodeId)}
              <article class="note-row" use:dismissNote={{open:editingNoteId===note.nodeId,close:()=>editingNoteId=""}}><div class="note-row-heading"><div><h3>{note.context.qualifiedName??note.context.label}</h3><p>{note.context.package} · {note.context.kind}</p></div><div class="toolbar"><button data-note-toggle onclick={()=>editingNoteId=editingNoteId===note.nodeId?'':note.nodeId}>{editingNoteId===note.nodeId?'Done':'Edit'}</button><button disabled={!note.text} aria-label={`Clear note for ${note.context.label}`} onclick={()=>clear(note.nodeId)}>Clear</button>{#if index?.byId.has(note.nodeId)}<button onclick={()=>open(note.nodeId)}>Go to node</button>{:else}<span class="absent">Absent from current snapshot</span>{/if}</div></div>{#if editingNoteId===note.nodeId}<div data-note-editor><textarea use:focusNote aria-label={`Note for ${note.context.label}`} rows="5" value={note.text} oninput={e=>save(note.nodeId,e.currentTarget.value)}></textarea></div>{:else}<button class="note-preview" data-note-toggle aria-label={`Edit note for ${note.context.label}`} onclick={()=>editingNoteId=note.nodeId}>{note.text||'Add a note…'}</button>{/if}<small>{saveStatus} · {new Date(note.modifiedAt).toLocaleString()}</small></article>
            {:else}<div class="empty-large"><h3>{noteQuery?'No matching notes':'Your API notebook starts here'}</h3><p>Use Note on any graph node to record a question, decision, or follow-up.</p><a class="button-link" href={sectionLinks.graph}>Explore the graph</a></div>{/each}
          </div>
        {:else}
          <div class="canvas-toolbar"><div class="breadcrumbs"><button aria-label="Go back" disabled={!history.length} onclick={()=>navigate(true)}>Back</button><button aria-label="Go forward" disabled={!future.length} onclick={()=>navigate(false)}>Forward</button><button class="crumb" onclick={()=>open('')}>Packages</button>{#each breadcrumbs as crumb (crumb.id)}<span>/</span><button class="crumb" title={crumb.label} onclick={()=>open(crumb.id)}>{crumb.label.replace('@leitwerk-dev/','')}</button>{/each}</div><div class="toolbar"><button disabled={layoutBusy||!layoutReady} onclick={layout}>{layoutBusy?'Laying out…':'Auto layout'}</button><button onclick={()=>fitCanvas()}>Fit</button>{#if view.hidden.length}<button onclick={()=>view={...view,hidden:[]}}>Restore hidden ({view.hidden.length})</button>{/if}</div></div>
          <div class="canvas-title"><div><h2>{view.root?index?.byId.get(view.root)?.label.replace('@leitwerk-dev/',''):'Package overview'}</h2><p>{view.root?`Expand members and types. ${focusNode&&usageMode(focusNode)==='usages'?'Usages':'Callers'} come from outside the package by default.`:'Consumers on the left → dependencies on the right. Connections count indexed usages.'}</p></div><span>{nodes.length} nodes · {edges.length} connections</span></div>
          <div class="canvas" aria-label="API relationship graph">
            <SvelteFlow bind:nodes bind:edges nodeTypes={{api:ApiCard}} minZoom={0.06} maxZoom={2} fitView nodesConnectable={false} deleteKey={null} onnodeclick={({node})=>inspect(node.id)} onnodedragstart={()=>{request++;layoutBusy=false;}} onnodedragstop={()=>{for(const n of nodes)positions.set(positionKey(view.root,n.id),n.position);}}>
              <Background gap={24} size={1} patternColor="#d7dce2"/><Controls showLock={false}/><MiniMap pannable zoomable nodeColor="#dae1eb" maskColor="rgba(248,249,251,.8)"/><FlowActions onready={fit=>fitCanvas=fit}/>
            </SvelteFlow>
            {#if !nodes.length}<div class="canvas-empty"><h3>No nodes to show</h3><p>Widen the filters or restore hidden branches.</p></div>{/if}
            {#if graph?.more.overview}<button class="overview-more" onclick={()=>moreClick('overview')}>Show more packages ({graph.more.overview})</button>{/if}
          </div>
          <div class="canvas-help">Drag to arrange · Scroll to zoom · Shift to select · Notes stay with their API identity</div>
        {/if}
      </main>
      <aside class="inspector" aria-label="Source and details">
        <div class="inspector-heading"><h2>Inspector</h2>{#if selected}<span>{selected.kind}</span>{/if}</div>
        {#if selected}
          <h3 class="detail-title">{selected.qualifiedName??selected.label}</h3><p class="detail-package">{selected.package}{selected.entry?` · ${selected.entry}`:''}</p>
          {#if selected.release}<div class="badge-row"><span class="badge" class:release-public={selected.release!=="internal"} class:release-internal={selected.release==="internal"}>{selected.release}</span><span class="badge">{selected.extraction==='extractor'?'API Extractor':'Source compiler'}</span></div>{/if}
          {#if graph?.fileScopes.has(selected.id)}<div class="badge-row"><span class="badge">{graph.fileScopes.get(selected.id)} {graph.fileModes.get(selected.id)==='usages'?'usages':'caller'}</span></div>{/if}
          {#if selectedUsageInfo}
            <section class="usage-evidence" aria-label="Usage evidence">
              <h4>{selectedUsageInfo.label}</h4><p>{selectedUsageInfo.explanation}</p>
              <dl class="usage-totals"><div><dt>External {selectedUsageInfo.mode}</dt><dd>{selectedUsageInfo.external}</dd></div><div><dt>Internal {selectedUsageInfo.mode}</dt><dd>{selectedUsageInfo.internal}</dd></div><div><dt>Test {selectedUsageInfo.mode}</dt><dd>{selectedUsageInfo.tests}</dd></div><div><dt>{selectedUsageInfo.mode==='usages'?'Imports / re-exports':'Other references'}</dt><dd>{selectedUsageInfo.mode==='usages'?selectedUsageInfo.imports:selectedUsageInfo.references}</dd></div></dl><small>{selectedUsageInfo.mode==='usages'?'Totals before filters. Imports and re-exports are included in usage counts.':'Totals before filters. Wiring below is separate from caller counts.'}</small>
              {#if selectedEvidence.length}<h4>Wiring</h4>{#each selectedEvidence.slice(0,evidenceLimit) as evidence,i (i)}<button class="evidence-link" class:active={evidenceSource===evidence} aria-expanded={evidenceSource===evidence} title={evidence.detail} onclick={()=>{evidenceSource=evidenceSource===evidence?null:evidence;occurrence=null;}}><strong>{evidence.label}</strong><small>{evidence.source.path}:{evidence.source.line}{evidence.isTest?' · test':''}</small></button>{#if evidenceSource===evidence}<div class="evidence-preview"><p>{evidence.detail}</p><div class="source-heading"><h4>Wiring source</h4><button onclick={copyLocation}>Copy path:line</button></div><p class="source-path">{evidence.source.path}:{evidence.source.line}</p><pre class="source-code"><code>{evidence.source.snippet}</code></pre></div>{/if}{/each}{#if selectedEvidence.length>evidenceLimit}<button onclick={()=>evidenceLimit+=8}>More evidence ({selectedEvidence.length-evidenceLimit})</button>{/if}{/if}
            </section>
          {/if}
          {#if selected.signatures?.length}<h4>Signature</h4>{#each selected.signatures as signature (signature)}<pre class="signature"><code>{signature}</code></pre>{/each}{/if}
          {#if selected.documentation}<h4>Documentation</h4><pre class="documentation">{selected.documentation}</pre>{/if}
          {#if !evidenceSource && (selected.source || occurrence)}{@const source=occurrence??selected.source!}<div class="source-heading"><h4>{occurrence?'Occurrence source':'Declaration source'}</h4><button onclick={copyLocation}>Copy path:line</button></div><p class="source-path">{source.path}:{source.line}</p><pre class="source-code"><code>{source.snippet||'Open this path in your editor to inspect the source.'}</code></pre>{/if}
          {#if ['package','entry'].includes(selected.kind)}<h4>Contents</h4>{#each (index?graphChildren(index,selected.id):[]).slice(0,20) as child (child.id)}<button class="detail-link" onclick={()=>open(child.id)}>{child.label}<small>{child.kind}{child.entry?` · ${child.entry}`:""}</small></button>{/each}<button class="detail-link" onclick={()=>open(selected.id)}>Explore all contents</button>{/if}
          <div class="source-heading"><h4>Usages <span class="count">{selectedUsages.length}</span></h4><select aria-label="Usage kind" bind:value={occurrenceKind}><option value="">All occurrences</option><option value="call">Calls / constructors</option><option value="type">Type references</option><option value="other">Other usages</option><option value="import">Imports</option><option value="re-export">Re-exports</option></select></div>
          {#each selectedUsages.slice(0,usageLimit) as usage (usage.id)}<button class="usage" class:active={occurrence?.id===usage.id} onclick={()=>{occurrence=usage;evidenceSource=null;}}><span>{usage.path}:{usage.line}</span><small>{usage.kind}{(usage.kind==='call'||selected.kind==='interface')&&selected.kind!=='file'&&index?.byId.has(usage.fileId)?` · ${usageScope(index.byId.get(usage.fileId)!,selected)}`:''}{usage.isTest?' · test':''}</small></button>{:else}<p class="empty">No indexed usages match these filters.</p>{/each}
          {#if selectedUsages.length>usageLimit}<button onclick={()=>usageLimit+=30}>Show more usages ({selectedUsages.length-usageLimit})</button>{/if}
          <section class="inspector-note" use:dismissNote={{open:inspectorNoteEditing,close:()=>inspectorNoteEditing=false}}><div class="source-heading"><h4>Markdown note</h4><div class="toolbar"><button data-note-toggle onclick={()=>inspectorNoteEditing=!inspectorNoteEditing}>{inspectorNoteEditing?'Done':'Edit'}</button><button disabled={!notes[selected.id]?.text} aria-label={`Clear inspector note for ${selected.label}`} onclick={()=>clear(selected.id)}>Clear</button></div></div>{#if inspectorNoteEditing}<div data-note-editor><textarea use:focusNote aria-label="Inspector note" rows="5" value={notes[selected.id]?.text??''} oninput={e=>save(selected.id,e.currentTarget.value)} placeholder="Add a note to this node…"></textarea></div>{:else}<button class="note-preview" data-note-toggle aria-label="Edit inspector note" onclick={()=>inspectorNoteEditing=true}>{notes[selected.id]?.text||'Add a note…'}</button>{/if}<small role="status">{saveStatus}</small></section>
        {:else}<div class="inspector-empty"><svg viewBox="0 0 64 64" aria-hidden="true"><rect x="5" y="23" width="19" height="18" rx="3"/><rect x="40" y="5" width="19" height="18" rx="3"/><rect x="40" y="41" width="19" height="18" rx="3"/><path d="M24 32h8V14h8M32 32v18h8"/></svg><h3>See the contract.<br/>Follow its use.</h3><p>Select a package to explore its exports, or search for a declaration by name.</p><p>Source snippets, references, and your notes appear here.</p></div>{/if}
      </aside>
    </div>
    <footer><button class:warning={!snapshot.coverage.complete||snapshot.diagnostics.some(d=>d.severity==='warning')} onclick={()=>showCoverage=!showCoverage}>{snapshot.coverage.complete?'Coverage':'Incomplete extraction'} · {snapshot.coverage.extractedEntryPoints}/{snapshot.coverage.entryPoints} entry points · {snapshot.diagnostics.length} diagnostics</button><span class="status-actions" role="status">{status}{#if noteUndo}<button onclick={undoClear}>Undo</button>{/if}</span><span title={snapshot.repository.revision}>{snapshot.repository.revision.slice(0,8)}{snapshot.repository.dirty?' + local changes':''} · {new Date(snapshot.generatedAt).toLocaleString()}</span></footer>
    {#if showCoverage}<section class="coverage-panel" aria-label="Index coverage"><div class="source-heading"><h2>Index coverage</h2><button onclick={()=>showCoverage=false}>Close</button></div><p>Source compiler: TypeScript {snapshot.coverage.typescriptVersion}. Test usages are {filters.tests?'visible':'hidden'}.</p>{#each snapshot.coverage.limitations as limitation (limitation)}<p>{limitation}</p>{/each}{#each snapshot.diagnostics.slice(0,150) as diagnostic,i (i)}<p class:warning={diagnostic.severity==='error'}><strong>{diagnostic.severity}</strong> · {diagnostic.scope}<br/>{diagnostic.message}</p>{/each}{#if snapshot.diagnostics.length>150}<p>First 150 diagnostics shown. Download the snapshot for the complete list.</p>{/if}<a href="/api/reports" download>Download snapshot and all diagnostics</a></section>{/if}
  {:else}<main class="startup"><h2>{loading?'Index snapshot loading…':'No snapshot loaded'}</h2><p>Start with <code>npm run dev --prefix tools/api-explorer-prototype</code>.</p><button disabled={loading} onclick={reload}>Retry loading</button></main>{/if}
</div>

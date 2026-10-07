<script lang="ts">
import { onMount, tick, untrack } from "svelte";
import type { WikiPage, WikiTopic } from "../index.js";
import type { WikiUiHost } from "./index.js";
import WikiEntryEditor from "./WikiEntryEditor.svelte";

let {
	topicId = "",
	pageId = "",
	reconnectCount = 0,
	host,
}: { topicId?: string; pageId?: string; reconnectCount?: number; host: WikiUiHost } = $props();
const {
	client,
	renderMarkdownToHtml,
	followLink,
	navigate,
	errorStatus,
	onWikiUpdated,
	PageHeader,
	ExternalLink,
} = untrack(() => host);
const { deleteWikiGroup, deleteWikiPage, fetchWikiHistory, fetchWikiTopic, fetchWikiTopics } =
	client;
let topics = $state<WikiTopic[]>([]);
let topic = $state<WikiTopic | null>(null);
let pages = $state<WikiPage[]>([]);
let history = $state<WikiPage[]>([]);
let historyLoading = $state(false);
let historyError = $state<string | null>(null);
let deleteError = $state<string | null>(null);
let deleteConflict = $state(false);
let indexLoaded = $state(false);
let search = $state("");
let status = $state("all");
let loading = $state(false);
let error = $state<string | null>(null);
let deleting = $state(false);
let confirmation = $state<WikiPage | null>(null);
let editing = $state<WikiPage | null>(null);
let editMessage = $state<string | null>(null);
let groupConfirmation = $state<WikiTopic | null>(null);
let deletingGroup = $state(false);
let groupDeleteError = $state<string | null>(null);
let groupDeleteConflict = $state(false);
let groupConfirmationHeading = $state<HTMLHeadingElement>();
let groupDeletionTrigger: HTMLButtonElement | undefined;
let editButton = $state<HTMLButtonElement>();
let generation = 0;
let historyGeneration = 0;
const selected = $derived(pages.find((page) => page.id === pageId) ?? null);
const filtered = $derived(
	pages.filter(
		(page) =>
			(status === "all" || page.status === status) &&
			`${page.title} ${page.applicability} ${page.markdown}`
				.toLowerCase()
				.includes(search.toLowerCase()),
	),
);
const pagePath = (id: string) => `/wiki/${encodeURIComponent(topicId)}/${encodeURIComponent(id)}`;
const statusLabel = (value: WikiPage["status"]) =>
	({
		proposed: "Proposed",
		observed: "Observed",
		validated: "Validated against cited evidence",
		needs_revalidation: "Needs revalidation",
	})[value];

function resetEntry() {
	historyGeneration++;
	history = [];
	historyLoading = false;
	historyError = null;
	deleteError = null;
	deleteConflict = false;
	confirmation = null;
}

async function load() {
	const request = ++generation;
	const requestedTopic = topicId;
	loading = true;
	error = null;
	try {
		if (requestedTopic) {
			const result = await fetchWikiTopic(requestedTopic);
			if (request !== generation) return;
			topic = result.topic;
			pages = result.pages;
			resetEntry();
		} else {
			const result = await fetchWikiTopics();
			if (request !== generation) return;
			topics = result.topics;
			indexLoaded = true;
			topic = null;
			pages = [];
		}
	} catch (cause) {
		if (request === generation) {
			error = cause instanceof Error ? cause.message : "Wiki unavailable";
			if (errorStatus(cause) === 404) {
				topic = null;
				pages = [];
				resetEntry();
			}
		}
	} finally {
		if (request === generation) loading = false;
	}
}

async function loadHistory() {
	if (historyLoading) return;
	const requestedTopic = topicId,
		requestedPage = pageId;
	const request = ++historyGeneration;
	historyLoading = true;
	historyError = null;
	try {
		const result = await fetchWikiHistory(requestedTopic, requestedPage);
		if (request === historyGeneration && requestedTopic === topicId && requestedPage === pageId)
			history = result.revisions;
	} catch (cause) {
		if (request === historyGeneration && requestedTopic === topicId && requestedPage === pageId)
			historyError = cause instanceof Error ? cause.message : "History unavailable";
	} finally {
		if (request === historyGeneration) historyLoading = false;
	}
}

async function removeEntry() {
	if (!confirmation) return;
	const target = confirmation;
	deleting = true;
	deleteError = null;
	deleteConflict = false;
	try {
		await deleteWikiPage(target);
		confirmation = null;
		if (target.topicId === topicId) {
			navigate(`/wiki/${topicId}`);
			await load();
		}
	} catch (cause) {
		if (target.topicId === topicId && target.id === pageId) {
			deleteError = cause instanceof Error ? cause.message : "Deletion failed";
			deleteConflict = errorStatus(cause) === 409;
		}
	} finally {
		deleting = false;
	}
}

async function confirmGroupDeletion(target: WikiTopic, trigger: HTMLButtonElement) {
	groupDeletionTrigger = trigger;
	groupConfirmation = target;
	groupDeleteError = null;
	groupDeleteConflict = false;
	await tick();
	if (groupConfirmation?.id !== target.id) return;
	groupConfirmationHeading?.focus();
	groupConfirmationHeading?.scrollIntoView?.({ block: "nearest" });
}

async function cancelGroupDeletion() {
	groupConfirmation = null;
	await tick();
	groupDeletionTrigger?.focus();
}

async function removeGroup() {
	if (!groupConfirmation || deletingGroup) return;
	const target = groupConfirmation;
	deletingGroup = true;
	groupDeleteError = null;
	try {
		await deleteWikiGroup(target);
		groupConfirmation = null;
		topics = topics.filter((item) => item.id !== target.id);
		if (target.id === topicId) {
			topic = null;
			pages = [];
			editing = null;
			navigate("/wiki");
		} else await load();
	} catch (cause) {
		groupDeleteError = cause instanceof Error ? cause.message : "Group deletion failed";
		groupDeleteConflict = errorStatus(cause) === 409;
	} finally {
		deletingGroup = false;
	}
}

async function refreshGroupDeletion() {
	await load();
	groupConfirmation = null;
}

async function reloadEditedEntry() {
	const requestedTopic = topicId,
		requestedPage = pageId;
	await load();
	if (requestedTopic === topicId && requestedPage === pageId && selected) editing = selected;
}

function savedEntry(page: WikiPage) {
	if (editing?.topicId !== page.topicId || editing.id !== page.id) return;
	pages = pages.map((current) => (current.id === page.id ? page : current));
	finishEditing();
	editMessage = "Entry saved.";
	resetEntry();
	void load();
}

function finishEditing() {
	editing = null;
	void tick().then(() => editButton?.focus());
}

$effect(() => {
	void topicId;
	void reconnectCount;
	pages = [];
	topic = null;
	void load();
});
$effect(() => {
	void pageId;
	void topicId;
	resetEntry();
	editing = null;
	editMessage = null;
	groupConfirmation = null;
});
onMount(() =>
	onWikiUpdated((updatedTopicId) => {
		if (!topicId || updatedTopicId === topicId) void load();
	}),
);
</script>

<div class="wiki-page" data-page="wiki">
	<PageHeader title={topic?.title ?? "Solution wikis"} subtitle="Reusable solutions for other processes in this topic, beyond what the tickets already describe. Check the cited evidence before applying guidance.">
		{#snippet actions()}<button class="ui-button" disabled={loading} onclick={() => void load()}>{loading ? "Refreshing…" : "Refresh"}</button>{#if topic}<button class="ui-button" disabled={loading || deletingGroup || !!editing} onclick={(event) => topic && void confirmGroupDeletion(topic, event.currentTarget)}>Delete wiki group…</button>{/if}{/snippet}
	</PageHeader>
	{#if error}<p role="alert">{error} <button class="ui-button" onclick={() => void load()}>Try again</button></p>{/if}
	{#if loading && !topic && !topics.length}<p role="status">Loading solution wiki…</p>{/if}
	{#if groupConfirmation}
		<section class="confirmation group-confirmation" aria-label="Confirm wiki group deletion">
			<h2 bind:this={groupConfirmationHeading} tabindex="-1">Delete “{groupConfirmation.title}” and all its entries?</h2>
			<p>This removes the entire wiki group from browsing and future agent reads. It cannot be restored or erase context already read by a running agent. Processes and published tickets remain available.</p>
			{#if groupDeleteError}<p role="alert">{groupDeleteError}</p>{/if}
			<div class="entry-actions">
				{#if groupDeleteConflict}<button class="ui-button" disabled={loading} onclick={() => void refreshGroupDeletion()}>Refresh group before deleting</button>
				{:else}<button class="ui-button" data-variant="danger" disabled={deletingGroup} onclick={() => void removeGroup()}>{deletingGroup ? "Deleting group…" : groupDeleteError ? "Retry group deletion" : "Delete group and all entries"}</button>{/if}
				<button class="ui-button" disabled={deletingGroup} onclick={() => void cancelGroupDeletion()}>Cancel</button>
			</div>
		</section>
	{/if}
	{#if !topicId}
		{#if indexLoaded && !loading && !error && !topics.length}<p>No solution wikis yet. Start a process that shares solutions with a topic.</p>{/if}
		<ul class="topic-list">{#each topics as item (item.id)}
			<li><a href={`/wiki/${item.id}`} onclick={(event) => followLink(event, `/wiki/${item.id}`)}>{item.title}</a><button class="ui-button" aria-label={`Delete wiki group ${item.title}`} disabled={loading || deletingGroup} onclick={(event) => void confirmGroupDeletion(item, event.currentTarget)}>Delete group…</button></li>
		{/each}</ul>
	{:else if topic || editing}
		<nav class="breadcrumbs" aria-label="Wiki navigation"><a href="/wiki" onclick={(event) => followLink(event, "/wiki")}>All solution wikis</a>{#if topic}<ExternalLink href={topic.url} label="Open topic source" />{/if}</nav>
		<div class="wiki-layout">
			<aside aria-label="Wiki entries">
				<label for="wiki-search">Find an entry</label><input id="wiki-search" type="search" bind:value={search} placeholder="Search solutions" />
				<label for="wiki-status">Evidence status</label><select id="wiki-status" bind:value={status}><option value="all">All entries</option><option value="needs_revalidation">Needs revalidation</option><option value="proposed">Proposed</option><option value="observed">Observed</option><option value="validated">Validated</option></select>
				<ul>{#each filtered as page (page.id)}<li><a class:selected={page.id === pageId} aria-current={page.id === pageId ? "page" : undefined} href={pagePath(page.id)} onclick={(event) => followLink(event, pagePath(page.id))}>{page.title}<span>{statusLabel(page.status)}</span></a></li>{/each}</ul>
				{#if !filtered.length}<p>{pages.length ? "No entries match these filters." : "No shared solutions yet."}</p>{/if}
			</aside>
			<article>
				{#if editing}
					{#key `${editing.topicId}:${editing.id}:${editing.revision}`}
						<WikiEntryEditor {host} page={editing} currentPage={selected} {pages} onSaved={savedEntry} onCancel={finishEditing} onReload={reloadEditedEntry} />
					{/key}
				{:else if selected}
					{#if editMessage}<p role="status">{editMessage}</p>{/if}
					<h2>{selected.title}</h2><p class="metadata">{statusLabel(selected.status)} · Revision {selected.revision} · {new Date(selected.updatedAt).toLocaleString()}</p>
					{#if selected.status === "needs_revalidation"}<p class="notice">Evidence or a linked entry changed. Revalidate this guidance before reuse.</p>{/if}
					<h3>Applies when</h3><p>{selected.applicability}</p>
					<div class="markdown">{@html renderMarkdownToHtml(selected.markdown)}</div>
					<h3>Evidence</h3><ul class="evidence">{#each selected.evidence as evidence}<li><strong>{evidence.repository}</strong><p>{evidence.path} · <code>{evidence.revision}</code></p><p>{evidence.observation}</p></li>{/each}</ul>
					<p><a href={`/processes/${selected.instanceId}`} onclick={(event) => followLink(event, `/processes/${selected.instanceId}`)}>Contributing process</a> · Source turn: {selected.turnRecordId}</p>
					{#if selected.updatedBy}<p class="metadata">Edited by {selected.updatedBy.displayName ?? selected.updatedBy.id}</p>{/if}
					{#if selected.links.length}<h3>Related entries</h3><ul>{#each selected.links as link}<li>{#if pages.some((page) => page.id === link)}<a href={pagePath(link)} onclick={(event) => followLink(event, pagePath(link))}>{pages.find((page) => page.id === link)?.title}</a>{:else}Entry removed; dependent guidance needs review.{/if}</li>{/each}</ul>{/if}
					<div class="entry-actions"><button class="ui-button" bind:this={editButton} disabled={deleting || !!confirmation} onclick={() => { editing = selected; editMessage = null; }}>Edit entry</button><button class="ui-button" disabled={historyLoading} onclick={() => void loadHistory()}>{historyLoading ? "Loading history…" : "Show revision history"}</button><button class="ui-button" disabled={deleting} onclick={() => { deleteError = null; confirmation = selected; }}>Delete entry…</button></div>
					{#if historyError}<p role="alert">{historyError} <button class="ui-button" disabled={historyLoading} onclick={() => void loadHistory()}>Retry history</button></p>{/if}
					{#if confirmation}<section class="confirmation" aria-label="Confirm entry deletion"><h3>Delete “{confirmation.title}”?</h3><p>This removes the entry from browsing and future agent reads. It cannot erase context already read by a running agent.</p>{#if deleteError}<p role="alert">{deleteError}</p>{/if}{#if deleteConflict}<button class="ui-button" disabled={loading} onclick={() => void load()}>Refresh entry before deleting</button>{:else}<button class="ui-button" disabled={deleting} onclick={() => void removeEntry()}>{deleting ? "Deleting…" : deleteError ? "Retry deletion" : "Delete entry"}</button>{/if}<button class="ui-button" disabled={deleting} onclick={() => confirmation = null}>Cancel</button></section>{/if}
					{#if history.length}<h3>Revision history</h3>{#each history as revision (revision.revision)}<details><summary>Revision {revision.revision} · {new Date(revision.updatedAt).toLocaleString()}</summary><div class="markdown">{@html renderMarkdownToHtml(revision.markdown)}</div></details>{/each}{/if}
				{:else}<h2>{pageId ? "Entry unavailable" : "Shared solutions"}</h2><p>{pageId ? "This entry may have been deleted. Choose another entry from the index." : "Select an entry to read its solution, applicability, and supporting evidence."}</p>{/if}
			</article>
		</div>
	{/if}
</div>

<style>
	.wiki-page { width: 100%; max-width: 1200px; margin: 0 auto; padding: var(--space-xl); color: var(--chronicle-text); box-sizing: border-box; }
	.breadcrumbs, .entry-actions { display: flex; flex-wrap: wrap; gap: var(--space-md); margin: var(--space-lg) 0; }
	.wiki-layout { display: grid; grid-template-columns: minmax(220px, 280px) minmax(0, 1fr); gap: var(--space-2xl); }
	aside { min-width: 0; }
	label { display: block; font-weight: 600; margin: var(--space-md) 0 var(--space-xs); }
	input, select { box-sizing: border-box; width: 100%; min-height: 44px; padding: var(--space-sm); border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-sm); background: var(--chronicle-panel-surface); color: var(--chronicle-text); font: inherit; }
	aside ul, .topic-list { list-style: none; padding: 0; }
	aside li, .topic-list li { border-bottom: 1px solid var(--chronicle-border); }
	.topic-list li { display: flex; align-items: center; gap: var(--space-md); padding: var(--space-sm) 0; }
	.topic-list a { flex: 1; min-width: 0; }
	.topic-list button { flex-shrink: 0; }
	.group-confirmation { margin: var(--space-lg) 0; }
	aside a, .topic-list a { display: block; padding: var(--space-md) var(--space-xs); overflow-wrap: anywhere; }
	aside a.selected { background: var(--chronicle-accent-soft); }
	aside span { display: block; color: var(--chronicle-text-muted); font-size: 0.875rem; margin-top: var(--space-xs); }
	article { min-width: 0; max-width: 75ch; overflow-wrap: anywhere; }
	h2 { font-size: 1.5rem; margin-top: 0; }
	h3 { margin-top: var(--space-xl); }
	p, .markdown { line-height: 1.65; }
	.metadata { color: var(--chronicle-text-muted); font-size: 0.875rem; }
	.notice, .confirmation { background: var(--chronicle-panel-muted); padding: var(--space-md); border-radius: var(--radius-sm); }
	.evidence { padding-left: var(--space-lg); }
	.evidence p { margin: var(--space-xs) 0; }
	.confirmation button { margin-right: var(--space-xs); }
	details { border-bottom: 1px solid var(--chronicle-border); padding: var(--space-sm) 0; }
	summary { cursor: pointer; min-height: 44px; }
	:global(.wiki-page pre) { max-width: 100%; overflow-x: auto; padding: var(--space-sm); background: var(--chronicle-panel-muted); }
	a { color: var(--chronicle-link); text-underline-offset: 0.2em; }
	aside a:hover, .topic-list a:hover { background: var(--chronicle-panel-muted); }
	input::placeholder { color: var(--chronicle-text-muted); }
	:global(.wiki-page a:focus-visible), input:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 3px; }
	@media (max-width: 760px) { .wiki-page { padding: var(--space-md); } .wiki-layout { grid-template-columns: minmax(0, 1fr); gap: var(--space-xl); } }
</style>

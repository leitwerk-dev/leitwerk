<script lang="ts">
import { tick, untrack } from "svelte";
import { parseWikiPageContent, type WikiPage } from "../index.js";
import type { WikiUiHost } from "./index.js";

let {
	page,
	host,
	currentPage,
	pages,
	onSaved,
	onCancel,
	onReload,
}: {
	page: WikiPage;
	host: WikiUiHost;
	currentPage: WikiPage | null;
	pages: WikiPage[];
	onSaved: (page: WikiPage) => void;
	onCancel: () => void;
	onReload: () => Promise<void>;
} = $props();
const initial = untrack(() => page);
const {
	client: { editWikiPage },
	renderMarkdownToHtml,
	errorStatus,
} = untrack(() => host);
let title = $state(initial.title);
let markdown = $state(initial.markdown);
let applicability = $state(initial.applicability);
let status = $state(initial.status);
let evidence = $state(initial.evidence.map((item) => ({ ...item })));
let links = $state([...initial.links]);
let saving = $state(false);
let reloading = $state(false);
let error = $state<string | null>(null);
let conflict = $state(false);
let titleInput = $state<HTMLInputElement>();
let errorElement = $state<HTMLParagraphElement>();
const stale = $derived(!currentPage || currentPage.revision !== page.revision);
const missingLinks = $derived(links.filter((id) => !pages.some((entry) => entry.id === id)));

$effect(() => {
	void tick().then(() => titleInput?.focus());
});

async function save(event: SubmitEvent) {
	event.preventDefault();
	if (saving || stale || conflict) return;
	error = null;
	try {
		const content = parseWikiPageContent({
			title,
			markdown,
			applicability,
			status,
			evidence,
			links,
		});
		saving = true;
		const result = await editWikiPage(page, content);
		onSaved(result.page);
	} catch (cause) {
		error =
			cause instanceof Error
				? cause.message
				: "Couldn't save this entry. Your draft has been kept.";
		conflict = errorStatus(cause) === 409 || errorStatus(cause) === 404;
		await tick();
		errorElement?.focus();
	} finally {
		saving = false;
	}
}

async function reload() {
	reloading = true;
	try {
		await onReload();
	} finally {
		reloading = false;
	}
}
</script>

<form aria-label="Edit wiki entry" onsubmit={save}>
	<h2>Edit entry</h2>
	<p class="hint">Keep only reusable solutions that add knowledge beyond the current ticket and shared source requirement. Explain when another process can apply the solution, why it works, and its limitations.</p>
	<p class="metadata">Editing revision {page.revision}. Saving creates a new revision.</p>
	{#if stale || conflict}
		<div class="notice" role="alert">
			<p>This entry changed or was deleted while you were editing. Your draft has been kept. Reloading replaces it with the latest entry.</p>
			<button type="button" class="ui-button" disabled={reloading} onclick={() => void reload()}>{reloading ? "Reloading…" : "Reload latest entry"}</button>
		</div>
	{/if}
	{#if error}<p role="alert" tabindex="-1" bind:this={errorElement}>{error}</p>{/if}
	<fieldset disabled={saving || reloading}>
		<label for="wiki-edit-title">Title</label>
		<input id="wiki-edit-title" bind:this={titleInput} bind:value={title} required />
		<label for="wiki-edit-applicability">Applies when</label>
		<textarea id="wiki-edit-applicability" bind:value={applicability} rows="3" required></textarea>
		<label for="wiki-edit-markdown">Entry text (Markdown)</label>
		<textarea id="wiki-edit-markdown" bind:value={markdown} rows="12" required></textarea>
		<details><summary>Preview entry text</summary><div class="markdown">{@html renderMarkdownToHtml(markdown)}</div></details>
		<label for="wiki-edit-status">Evidence status</label>
		<select id="wiki-edit-status" bind:value={status}><option value="proposed">Proposed</option><option value="observed">Observed</option><option value="validated">Validated against cited evidence</option><option value="needs_revalidation">Needs revalidation</option></select>
		<h3>Evidence</h3>
		<p class="hint">Keep at least one observation and the commit inspected. Mark guidance that still needs checking as Needs revalidation.</p>
		{#each evidence as item, index}
			<section class="evidence-row" aria-label={`Evidence ${index + 1}`}>
				<div class="evidence-fields">
					<div><label for={`wiki-evidence-repository-${index}`}>Repository</label><input id={`wiki-evidence-repository-${index}`} bind:value={item.repository} required /></div>
					<div><label for={`wiki-evidence-path-${index}`}>Path</label><input id={`wiki-evidence-path-${index}`} bind:value={item.path} required /></div>
				</div>
				<label for={`wiki-evidence-revision-${index}`}>Commit SHA</label><input id={`wiki-evidence-revision-${index}`} bind:value={item.revision} pattern={"([a-fA-F0-9]{40}|[a-fA-F0-9]{64})"} title="40 or 64 hexadecimal characters" required />
				<label for={`wiki-evidence-observation-${index}`}>Observation</label><textarea id={`wiki-evidence-observation-${index}`} bind:value={item.observation} rows="3" required></textarea>
				<button type="button" class="ui-button" aria-label={`Remove evidence ${index + 1}`} onclick={() => evidence = evidence.filter((_, i) => i !== index)}>Remove evidence</button>
			</section>
		{/each}
		<button type="button" class="ui-button" onclick={() => evidence = [...evidence, { repository: "", path: "", revision: "", observation: "" }]}>Add evidence</button>
		<h3>Related entries</h3>
		{#each pages.filter((entry) => entry.id !== page.id) as related (related.id)}
			<label class="related"><input type="checkbox" value={related.id} bind:group={links} />{related.title}</label>
		{/each}
		{#each missingLinks as id (id)}<label class="related"><input type="checkbox" value={id} bind:group={links} />{id} (entry unavailable; uncheck to remove)</label>{/each}
		{#if pages.length <= 1 && !missingLinks.length}<p class="hint">No other entries in this wiki group.</p>{/if}
	</fieldset>
	<div class="actions">
		<button class="ui-button" data-variant="primary" type="submit" disabled={saving || reloading || stale || conflict}>{saving ? "Saving…" : "Save changes"}</button>
		<button class="ui-button" type="button" disabled={saving || reloading} onclick={onCancel}>Cancel editing</button>
	</div>
</form>

<style>
	fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
	h2 { margin-top: 0; font-size: 1.5rem; }
	h3 { margin-top: var(--space-xl); }
	label { display: block; font-weight: 600; margin: var(--space-md) 0 var(--space-xs); }
	input, select, textarea { box-sizing: border-box; width: 100%; min-height: 44px; padding: var(--space-sm); border: 1px solid var(--chronicle-border-strong); border-radius: var(--radius-sm); background: var(--chronicle-panel-surface); color: var(--chronicle-text); font: inherit; caret-color: var(--chronicle-accent); }
	textarea { resize: vertical; line-height: 1.6; }
	input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 3px; }
	.metadata, .hint { color: var(--chronicle-text-muted); line-height: 1.6; }
	.metadata { font-size: 0.875rem; }
	.notice { background: var(--chronicle-panel-muted); padding: var(--space-md); border-radius: var(--radius-sm); }
	.evidence-row { padding-bottom: var(--space-md); margin-bottom: var(--space-md); border-bottom: 1px solid var(--chronicle-border); }
	.evidence-row button { margin-top: var(--space-sm); }
	.evidence-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-md); }
	.related { display: flex; gap: var(--space-sm); align-items: center; min-height: 44px; font-weight: 400; }
	.related input { width: 20px; min-height: 20px; flex: 0 0 20px; accent-color: var(--chronicle-accent); }
	.actions { display: flex; flex-wrap: wrap; gap: var(--space-sm); margin-top: var(--space-xl); }
	details { margin-top: var(--space-sm); }
	summary { cursor: pointer; padding: var(--space-sm) 0; min-height: 44px; box-sizing: border-box; }
	.markdown { overflow-wrap: anywhere; }
	@media (max-width: 760px) { .evidence-fields { grid-template-columns: minmax(0, 1fr); gap: 0; } }
</style>

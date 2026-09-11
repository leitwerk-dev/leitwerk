<script lang="ts">
import PageHeader from "../components/PageHeader.svelte";
import ProcessActionsMenu from "../components/ProcessActionsMenu.svelte";
import { getBrowserStorage } from "../lib/browser-storage.js";
import { formatLocalDateTime24Hour } from "../lib/format.js";
import { isPlainShortcut, isTextEntryTarget } from "../lib/keyboard.js";
import {
	buildProcessBrowserItems,
	EMPTY_PROCESS_BROWSER_STATUS_COUNTS,
	hasActiveFilters,
	PROCESS_BROWSER_PAGE_SIZE,
	type ProcessBrowserItem,
	type ProcessBrowserSort,
	type ProcessBrowserSortKey,
	type ProcessBrowserStatusFilter,
	readProcessBrowserView,
	writeProcessBrowserView,
} from "../lib/process-browser.js";
import { getProcessTerminalIcon } from "../lib/process-terminal-display.js";
import { browseItems, browseState, loadProcessBrowse } from "../lib/processes.svelte";
import { buildFutureLaunchPath, buildProcessPath, navigate } from "../lib/router.svelte";

type StatusFilterOption = { value: ProcessBrowserStatusFilter; label: string };
const liveStatusFilters: StatusFilterOption[] = [
	{ value: "all", label: "All" },
	{ value: "running", label: "Running" },
	{ value: "scheduled", label: "Scheduled" },
	{ value: "needs_attention", label: "Needs attention" },
];
const archiveStatusFilters: StatusFilterOption[] = [
	{ value: "completed", label: "Completed" },
	{ value: "aborted", label: "Aborted" },
];
const browserViewStorage = getBrowserStorage();
const initialView = readProcessBrowserView(browserViewStorage);

let searchInputRef = $state<HTMLInputElement | null>(null);
let query = $state("");
let statusFilter = $state<ProcessBrowserStatusFilter>(initialView.status);
let processTypeFilter = $state(initialView.processType);
let sort = $state<ProcessBrowserSort>(initialView.sort);

const allItems = $derived(buildProcessBrowserItems($browseItems));
const processTypeOptions = $derived($browseState.facets?.processTypes ?? []);
const filters = $derived({ status: statusFilter, query, processType: processTypeFilter });
const statusCounts = $derived(
	$browseState.facets?.statusCounts ?? EMPTY_PROCESS_BROWSER_STATUS_COUNTS,
);
const hasMore = $derived(Boolean($browseState.pagination?.hasMore));
const totalResultCount = $derived(
	($browseState.pagination?.processTotal ?? 0) +
		($browseState.pagination?.futureExecutionTotal ?? 0),
);
const hasActiveFilter = $derived(hasActiveFilters(filters));

function browseRequest(limit = PROCESS_BROWSER_PAGE_SIZE, offset?: number) {
	return {
		limit,
		...(offset === undefined ? {} : { offset }),
		query,
		status: statusFilter,
		processType: processTypeFilter,
		sortKey: sort.key,
		sortDirection: sort.direction,
	};
}

$effect(() => {
	writeProcessBrowserView(browserViewStorage, {
		status: statusFilter,
		processType: processTypeFilter,
		sort,
	});
});

$effect(() => {
	const timer = setTimeout(() => void loadProcessBrowse(browseRequest()), query.trim() ? 180 : 0);
	return () => clearTimeout(timer);
});

function sortButtonLabel(key: ProcessBrowserSortKey, label: string): string {
	if (sort.key !== key) {
		return `Sort by ${label}`;
	}
	const next = sort.direction === "asc" ? "descending" : "ascending";
	const current = sort.direction === "asc" ? "ascending" : "descending";
	return `${label}, sorted ${current}. Activate to sort ${next}.`;
}

function toggleSort(key: ProcessBrowserSortKey) {
	if (sort.key === key) {
		sort = { key, direction: sort.direction === "asc" ? "desc" : "asc" };
	} else {
		// New column starts ascending for names, descending for status/time where
		// the most relevant rows belong at the top.
		sort = { key, direction: key === "title" ? "asc" : "desc" };
	}
}

function updateQuery(event: Event) {
	query = (event.currentTarget as HTMLInputElement).value;
}

function setStatusFilter(next: ProcessBrowserStatusFilter) {
	statusFilter = next;
}

function updateProcessType(event: Event) {
	processTypeFilter = (event.currentTarget as HTMLSelectElement).value;
}

function clearFilters() {
	query = "";
	statusFilter = "all";
	processTypeFilter = "";
	searchInputRef?.focus();
}

function showMore() {
	const pagination = $browseState.pagination;
	if (!pagination) return;
	void loadProcessBrowse(browseRequest(pagination.limit, allItems.length), { append: true });
}

function refreshProcesses() {
	void loadProcessBrowse(browseRequest());
}

function itemHref(item: ProcessBrowserItem): string {
	if (item.kind === "future" && item.futureExecutionId) {
		return buildFutureLaunchPath(item.futureExecutionId);
	}
	return buildProcessPath(item.instanceId ?? item.id);
}

function followItem(item: ProcessBrowserItem, event: MouseEvent) {
	event.preventDefault();
	navigate(itemHref(item));
}

function statusMark(item: ProcessBrowserItem): string {
	switch (item.statusFilter) {
		case "running":
			return "R";
		case "scheduled":
			return "S";
		case "needs_attention":
			return "W";
		case "completed":
			return getProcessTerminalIcon("completed");
		case "aborted":
			return getProcessTerminalIcon("aborted");
		default:
			return "?";
	}
}

function timestampLabel(item: ProcessBrowserItem): string {
	if (!item.sortAt) {
		return "No timestamp";
	}
	const formatted = formatLocalDateTime24Hour(item.sortAt);
	if (item.statusFilter === "scheduled") {
		return `Runs ${formatted}`;
	}
	if (item.statusFilter === "completed" || item.statusFilter === "aborted") {
		return `Closed ${formatted}`;
	}
	return `Updated ${formatted}`;
}

function rowSummary(item: ProcessBrowserItem): string {
	const prompt = item.initialPrompt ? ` Initial prompt: ${item.initialPrompt}` : "";
	return `${item.title}. ${item.statusDetail}. ${timestampLabel(item)}.${prompt}`;
}

function handleWindowKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented || !isPlainShortcut(event) || event.key !== "/") {
		return;
	}
	if (isTextEntryTarget(event.target)) {
		return;
	}
	event.preventDefault();
	searchInputRef?.focus();
	searchInputRef?.select();
}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#snippet filterChips(options: StatusFilterOption[], archive = false)}
	{#each options as filter (filter.value)}
		<button
			type="button"
			class="filter-chip"
			class:archive-chip={archive}
			class:is-active={statusFilter === filter.value}
			data-filter-status={filter.value}
			data-pressable="true"
			aria-pressed={statusFilter === filter.value}
			onclick={() => setStatusFilter(filter.value)}
		>
			<span>{filter.label}</span>
			<span class="chip-count">{statusCounts[filter.value]}</span>
		</button>
	{/each}
{/snippet}

{#snippet sortHeader(key: ProcessBrowserSortKey, label: string)}
	<button
		type="button"
		class="column-sort"
		class:is-active={sort.key === key}
		data-sort-key={key}
		aria-label={sortButtonLabel(key, label)}
		onclick={() => toggleSort(key)}
	>
		<span>{label}</span>
		<span class="sort-arrow" aria-hidden="true">
			{#if sort.key === key}{sort.direction === "asc" ? "↑" : "↓"}{:else}↕{/if}
		</span>
	</button>
{/snippet}

<section class="processes-page" data-section="all-processes-page">
	<PageHeader
		title="All processes"
		subtitle="Browse current, scheduled, and past process records. Search or filter to narrow the list."
	/>

	<div class="browser-panel" data-section="process-browser">
		<div class="browser-toolbar" data-section="process-browse-controls">
			<label class="search-field">
				<span class="sr-only">Search</span>
				<input
					bind:this={searchInputRef}
					type="search"
					value={query}
					placeholder="Search processes by title or prompt"
					aria-label="Search processes by title or prompt"
					oninput={updateQuery}
				/>
			</label>

			<label class="type-filter">
				<span class="sr-only">Process type</span>
				<select value={processTypeFilter} onchange={updateProcessType} data-filter="process-type">
					<option value="">All process types</option>
					{#if $browseState.facets && processTypeFilter && !processTypeOptions.some((option) => option.value === processTypeFilter)}
						<option value={processTypeFilter}>{processTypeFilter} (unavailable)</option>
					{/if}
					{#each processTypeOptions as option (option.value)}
						<option value={option.value}>{option.label} ({option.count})</option>
					{/each}
				</select>
			</label>

			<p class="result-count" aria-live="polite">
				<span>{totalResultCount}</span>
				{totalResultCount === 1 ? "record" : "records"}
			</p>

			{#if hasActiveFilter}
				<button type="button" class="ui-button reset-view-button" data-pressable="true" onclick={clearFilters}>
					Clear filters
				</button>
			{/if}

			<button
				type="button"
				class="ui-button refresh-button"
				data-action="refresh-processes"
				data-pressable="true"
				disabled={$browseState.loading}
				onclick={refreshProcesses}
			>
				{$browseState.loading ? "Refreshing…" : "Refresh"}
			</button>
		</div>

		<div class="filter-row" role="group" aria-label="Process status filters">
			<span class="filter-row-label">Status</span>
			<div class="filter-group">
				{@render filterChips(liveStatusFilters)}
			</div>
			<div class="filter-group archive-group">
				{@render filterChips(archiveStatusFilters, true)}
			</div>
		</div>

		{#if $browseState.error}
			<div class="state-banner" role="status" data-state="process-list-error">
				<p>Process list couldn’t refresh. Existing results may be out of date.</p>
				<button type="button" class="ui-button" data-pressable="true" onclick={refreshProcesses}>Try again</button>
			</div>
		{/if}

		<div class="process-table-shell">
			<div class="process-table-heading">
				{@render sortHeader("status", "Status")}
				{@render sortHeader("title", "Process")}
				<span class="prompt-heading">Initial prompt</span>
				{@render sortHeader("timeline", "Timeline")}
				<span class="actions-heading">Actions</span>
			</div>

			{#if $browseState.loading && allItems.length === 0}
				<div class="skeleton-list" data-state="processes-loading" role="status">
					{#each Array(6) as _, index (index)}
						<div class="skeleton-row"></div>
					{/each}
				</div>
			{:else if allItems.length === 0 && hasActiveFilter}
				<div class="empty-state" data-state="processes-no-results">
					<h2>No processes match these filters</h2>
					<p>Change the search or filters to see more process records.</p>
					<button type="button" class="ui-button clear-button" data-pressable="true" onclick={clearFilters}>
						Clear search and filters
					</button>
				</div>
			{:else if allItems.length === 0}
				<div class="empty-state" data-state="processes-empty">
					<h2>No process records yet</h2>
					<p>Started and scheduled processes will appear here.</p>
				</div>
			{:else}
				<div class="process-table" data-section="process-browser-results">
					{#each allItems as item (item.id)}
						<article
							class="process-browser-row"
							data-process-browser-row=""
							data-item-id={item.id}
							data-item-kind={item.kind}
							data-status-filter={item.statusFilter}
						>
							<a
								href={itemHref(item)}
								class="row-main"
								data-pressable="true"
								aria-label={rowSummary(item)}
								onclick={(event) => followItem(item, event)}
							>
								<span class={`status-mark ${item.statusFilter}`} aria-hidden="true">
									{statusMark(item)}
								</span>

								<span class="row-process">
									<span class="row-title">{item.title}</span>
									<span class="row-meta">
										{item.statusDetail} · {item.processDisplayName}
									</span>
								</span>

								<span class="prompt-cell">
									{#if item.initialPrompt}
										{item.initialPrompt}
									{:else}
										<span class="muted">No initial prompt captured</span>
									{/if}
								</span>

								<span class="time-cell">{timestampLabel(item)}</span>
							</a>

							<div class="row-actions" data-process-actions-for={item.instanceId ?? item.id}>
								{#if item.kind === "process" && item.instanceId}
									<ProcessActionsMenu
										instanceId={item.instanceId}
										lifecycleStatus={item.lifecycleStatus}
										processLabel={item.title}
										onDeleted={refreshProcesses}
									/>
								{:else}
									<span class="future-action-note">Scheduled start</span>
								{/if}
							</div>
						</article>
					{/each}
				</div>
			{/if}
		</div>

		{#if hasMore}
			<div class="pagination-row">
				<button type="button" class="ui-button show-more-button" data-pressable="true" onclick={showMore}>
					Show more
				</button>
			</div>
		{/if}
	</div>
</section>

<style>
	.processes-page {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
		width: 100%;
		min-height: 0;
		height: 100%;
		padding: var(--space-2xs) 2px var(--space-xl);
		box-sizing: border-box;
		color: var(--chronicle-text);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	/* The browser panel binds the toolbar, status chips, and table into one
	   surface so the controls read as part of the table rather than floating cards. */
	.browser-panel {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 88%, white 12%);
		border-radius: 14px;
		background: var(--chronicle-panel-surface);
		overflow: visible;
		box-shadow: var(--chronicle-shadow-soft);
	}

	.browser-toolbar {
		display: grid;
		grid-template-columns: minmax(280px, 1fr) minmax(210px, 260px) auto auto auto;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-md);
		border-bottom: 1px solid var(--chronicle-border);
		border-radius: 14px 14px 0 0;
		background: linear-gradient(180deg, var(--chronicle-card-surface), var(--chronicle-panel-muted));
	}

	.result-count {
		margin: 0;
		display: inline-flex;
		align-items: baseline;
		justify-content: flex-end;
		gap: 6px;
		font-size: var(--type-caption);
		font-weight: 800;
		letter-spacing: 0.02em;
		color: var(--chronicle-text-muted);
		white-space: nowrap;
	}

	.result-count span {
		font-family: var(--font-mono);
		font-size: 1.35rem;
		line-height: 1;
		letter-spacing: normal;
		color: var(--chronicle-text);
	}

	.search-field {
		flex: 1 1 auto;
		min-width: 200px;
	}

	.type-filter {
		flex: 0 0 auto;
	}

	.search-field input,
	.type-filter select {
		width: 100%;
		min-height: 44px;
		border: 1px solid var(--chronicle-border);
		border-radius: 10px;
		background: var(--chronicle-card-surface);
		color: var(--chronicle-text);
		font-size: var(--type-body);
		outline: none;
	}

	.search-field input {
		padding: 0 14px;
	}

	.type-filter select {
		padding: 0 38px 0 12px;
	}

	.search-field input:focus,
	.type-filter select:focus {
		border-color: color-mix(in srgb, var(--chronicle-accent) 48%, var(--chronicle-border) 52%);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--chronicle-accent) 16%, transparent 84%);
	}

	.filter-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
		padding: 10px var(--space-md);
		border-bottom: 1px solid var(--chronicle-border);
		background: color-mix(in srgb, var(--chronicle-panel-muted) 72%, white 28%);
	}

	.filter-row-label {
		font-size: var(--type-label);
		font-weight: 850;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--chronicle-text-faint);
	}

	.filter-group {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}

	.archive-group {
		padding-left: var(--space-sm);
		border-left: 1px solid var(--chronicle-border);
	}

	.filter-chip {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 34px;
		padding: 0 11px;
		border-radius: 9px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 92%, white 8%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 86%, var(--chronicle-panel-muted) 14%);
		color: var(--chronicle-text-muted);
		font-size: var(--type-body-sm);
		font-weight: 800;
		cursor: pointer;
	}

	.filter-chip:hover,
	.filter-chip.is-active {
		border-color: color-mix(in srgb, var(--chronicle-accent) 42%, var(--chronicle-border-strong) 58%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 80%, var(--chronicle-accent) 20%);
		color: var(--chronicle-text);
	}

	.chip-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 24px;
		height: 22px;
		padding: 0 7px;
		border-radius: 7px;
		background: color-mix(in srgb, var(--chronicle-panel-muted) 78%, white 22%);
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 850;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.04em;
		color: var(--chronicle-text-faint);
	}

	.filter-chip.is-active .chip-count {
		background: var(--chronicle-accent);
		color: var(--chronicle-text-on-accent);
	}

	.state-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		margin: var(--space-md);
		padding: 12px 14px;
		border: 1px solid var(--chronicle-danger-border);
		border-radius: var(--radius-lg);
		background: var(--chronicle-danger-surface-soft);
		color: var(--chronicle-danger-text);
	}

	.state-banner p {
		margin: 0;
		font-size: var(--type-body-sm);
		font-weight: 700;
	}

	.process-table-shell {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		flex-direction: column;
	}

	.process-table-heading {
		display: grid;
		grid-template-columns: 74px minmax(240px, 1.25fr) minmax(240px, 1fr) minmax(170px, 0.62fr) 76px;
		gap: var(--space-md);
		padding: 4px var(--space-md);
		border-bottom: 1px solid var(--chronicle-border);
		background: color-mix(in srgb, var(--chronicle-text) 5%, var(--chronicle-panel-muted) 95%);
	}

	.column-sort {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 34px;
		padding: 0 8px;
		margin: 0 -8px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--chronicle-text-muted);
		font-size: var(--type-label);
		font-weight: 800;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		cursor: pointer;
	}

	.column-sort:hover {
		background: color-mix(in srgb, var(--chronicle-panel-muted) 60%, var(--chronicle-accent) 12%);
		color: var(--chronicle-text);
	}

	.column-sort.is-active {
		color: var(--chronicle-accent);
	}

	.sort-arrow {
		font-size: 12px;
		line-height: 1;
		opacity: 0.55;
	}

	.column-sort.is-active .sort-arrow {
		opacity: 1;
	}

	.prompt-heading,
	.actions-heading {
		display: inline-flex;
		align-items: center;
		font-size: var(--type-label);
		font-weight: 800;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--chronicle-text-muted);
	}

	.process-table,
	.skeleton-list {
		overflow-y: auto;
		min-height: 0;
	}

	.process-browser-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: stretch;
		border-bottom: 1px solid color-mix(in srgb, var(--chronicle-border) 78%, transparent 22%);
		background: var(--chronicle-card-surface);
	}

	.process-browser-row:last-child {
		border-bottom: 0;
	}

	.process-browser-row:hover {
		background: color-mix(in srgb, var(--chronicle-card-surface) 88%, var(--chronicle-accent) 12%);
	}

	.row-main {
		display: grid;
		grid-template-columns: 74px minmax(240px, 1.25fr) minmax(240px, 1fr) minmax(170px, 0.62fr);
		gap: var(--space-md);
		align-items: center;
		min-width: 0;
		padding: 15px var(--space-md);
		color: inherit;
		text-decoration: none;
	}

	.status-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: 8px;
		background: var(--chronicle-text-faint);
		color: var(--chronicle-text-on-accent);
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 900;
		justify-self: start;
		box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.12);
	}

	.status-mark.running {
		background: color-mix(in srgb, var(--chronicle-accent) 12%, white 88%);
		color: var(--chronicle-accent);
		box-shadow: inset 0 0 0 2px var(--chronicle-accent);
	}

	.status-mark.scheduled {
		background: var(--chronicle-attention);
	}

	.status-mark.needs_attention {
		background: color-mix(in srgb, var(--chronicle-attention) 12%, white 88%);
		color: color-mix(in srgb, var(--chronicle-attention) 76%, var(--chronicle-text) 24%);
		box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--chronicle-attention) 76%, var(--chronicle-text) 24%);
	}

	.status-mark.completed {
		background: var(--chronicle-success);
	}

	.status-mark.aborted {
		background: var(--chronicle-text-faint);
	}

	.row-process,
	.prompt-cell,
	.time-cell {
		min-width: 0;
	}

	.row-process {
		display: grid;
		gap: 4px;
	}

	.row-title {
		font-size: var(--type-body-lg);
		font-weight: 760;
		line-height: 1.35;
		color: var(--chronicle-text);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.row-meta,
	.time-cell,
	.future-action-note {
		font-size: var(--type-caption);
		font-weight: 700;
		line-height: 1.45;
		color: var(--chronicle-text-faint);
	}

	.prompt-cell {
		font-size: var(--type-body-sm);
		line-height: 1.45;
		color: var(--chronicle-text-muted);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.muted {
		color: color-mix(in srgb, var(--chronicle-text-faint) 72%, white 28%);
	}

	.time-cell {
		font-variant-numeric: tabular-nums;
	}

	.row-actions {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 76px;
		padding: 0 var(--space-md) 0 0;
	}

	.future-action-note {
		padding: 6px 8px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--chronicle-panel-muted) 76%, white 24%);
	}

	.empty-state {
		display: grid;
		place-items: center;
		align-content: center;
		gap: var(--space-sm);
		min-height: 280px;
		padding: var(--space-xl);
		text-align: center;
	}

	.empty-state h2,
	.empty-state p {
		margin: 0;
	}

	.empty-state h2 {
		font-family: var(--font-display);
		font-size: var(--type-title-lg);
		line-height: 1.1;
	}

	.empty-state p {
		max-width: 48ch;
		color: var(--chronicle-text-muted);
	}

	.skeleton-list {
		display: grid;
		gap: 0;
	}

	.skeleton-row {
		height: 74px;
		border-bottom: 1px solid color-mix(in srgb, var(--chronicle-border) 68%, transparent 32%);
		background:
			linear-gradient(
				90deg,
				transparent,
				color-mix(in srgb, var(--chronicle-panel-muted) 70%, white 30%),
				transparent
			),
			color-mix(in srgb, var(--chronicle-card-surface) 92%, var(--chronicle-panel-muted) 8%);
		background-size: 220% 100%;
		animation: skeleton-sweep 1.3s var(--ease-out-quart) infinite;
	}

	@keyframes skeleton-sweep {
		from {
			background-position: 120% 0;
		}

		to {
			background-position: -120% 0;
		}
	}

	.pagination-row {
		display: flex;
		justify-content: center;
		padding: var(--space-md);
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 82%, white 18%);
	}

	@media (prefers-reduced-motion: reduce) {
		.skeleton-row {
			animation: none;
		}
	}

	@media (max-width: 1120px) {
		.browser-toolbar {
			grid-template-columns: minmax(260px, 1fr) minmax(200px, 240px) auto;
		}

		.result-count,
		.reset-view-button {
			justify-self: start;
		}

		.process-table-heading {
			display: none;
		}

		.process-browser-row {
			grid-template-columns: 1fr;
		}

		.row-main {
			grid-template-columns: 42px minmax(0, 1fr);
			gap: var(--space-sm);
		}

		.prompt-cell,
		.time-cell {
			grid-column: 2;
		}

		.row-actions {
			justify-content: flex-start;
			padding: 0 var(--space-md) var(--space-md) 56px;
		}
	}

	@media (max-width: 720px) {
		.processes-page {
			height: auto;
			gap: var(--space-md);
		}

		.state-banner {
			align-items: stretch;
			flex-direction: column;
		}

		.browser-panel {
			overflow: visible;
			border-radius: 12px;
		}

		.browser-toolbar {
			grid-template-columns: 1fr;
			padding: var(--space-sm);
		}

		.result-count {
			justify-self: start;
		}

		.refresh-button,
		.reset-view-button,
		.search-field,
		.type-filter {
			width: 100%;
		}

		.filter-row {
			align-items: flex-start;
			gap: var(--space-xs);
			padding: var(--space-sm);
		}

		.filter-row-label {
			width: 100%;
		}

		.archive-group {
			width: 100%;
			padding-left: 0;
			padding-top: var(--space-xs);
			border-left: 0;
			border-top: 1px solid var(--chronicle-border);
		}

		.process-table,
		.skeleton-list {
			overflow: visible;
		}

		.row-main {
			padding: var(--space-md) var(--space-sm) var(--space-sm);
		}

		.row-actions {
			padding: 0 var(--space-sm) var(--space-md) 54px;
		}
	}
</style>

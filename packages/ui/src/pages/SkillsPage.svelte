<script lang="ts">
import { onMount, tick, untrack } from "svelte";
import ChronicleMarkdown from "../chronicle/components/ChronicleMarkdown.svelte";
import ModalShell from "../components/ModalShell.svelte";
import PageHeader from "../components/PageHeader.svelte";
import {
	fetchInstalledSkillDetail,
	fetchSkillDetail,
	fetchSkills,
	type InstalledSkillCatalogDetail,
	type InstalledSkillCatalogItem,
	refreshSkills,
	registerSkill,
	removeSkill,
	type SkillCatalogDetail,
	type SkillCatalogItem,
	type SkillRepositorySummary,
} from "../lib/api.js";
import { formatLocalDateTime } from "../lib/format.js";
import {
	buildAvailableSkillPath,
	buildInstalledSkillPath,
	buildProcessPath,
	buildSkillsPath,
	followLink,
	navigate,
} from "../lib/router.svelte";

interface Props {
	detailKind?: string | null;
	repositoryId?: string | null;
	skillId?: string | null;
}

type CatalogView = "installed" | "available";
type RemoteFilter = "all" | "available" | "updates" | "invoked" | "stale";
type DetailSection = "overview" | "instructions";
type SkillDetail =
	| { kind: "available"; value: SkillCatalogDetail }
	| { kind: "installed"; value: InstalledSkillCatalogDetail };
type SkillRowItem =
	| { kind: "available"; value: SkillCatalogItem }
	| { kind: "installed"; value: InstalledSkillCatalogItem };

let { detailKind = null, repositoryId = null, skillId = null }: Props = $props();
let repositories = $state.raw<SkillRepositorySummary[]>([]);
let availableSkills = $state.raw<SkillCatalogItem[]>([]);
let installedSkills = $state.raw<InstalledSkillCatalogItem[]>([]);
let detail = $state.raw<SkillDetail | null>(null);
let selectedView = $state<CatalogView>("installed");
let loading = $state(true);
let refreshing = $state(false);
let detailLoading = $state(false);
let error = $state<string | null>(null);
let detailError = $state<string | null>(null);
let actionError = $state<string | null>(null);
let actionSuccess = $state<string | null>(null);
let actionPending = $state(false);
let confirmRemove = $state(false);
let detailSection = $state<DetailSection>("overview");
let showRepositoriesModal = $state(false);
let query = $state("");
let repositoryFilter = $state("all");
let remoteFilter = $state<RemoteFilter>("available");
let detailRequestToken = 0;
let searchInputEl: HTMLInputElement | null = null;
let removeButtonEl = $state<HTMLButtonElement | null>(null);
let confirmRemoveButtonEl = $state<HTMLButtonElement | null>(null);

function handleGlobalKeydown(event: KeyboardEvent) {
	const activeElement = document.activeElement;
	const isInputActive =
		activeElement &&
		(activeElement.tagName === "INPUT" ||
			activeElement.tagName === "SELECT" ||
			activeElement.tagName === "TEXTAREA");

	if (event.key === "/" && !isInputActive) {
		event.preventDefault();
		searchInputEl?.focus();
	} else if (event.key === "Escape") {
		if (showRepositoriesModal) {
			showRepositoriesModal = false;
		} else if (confirmRemove) {
			cancelRemove();
		} else if (selectedKey) {
			navigate(buildSkillsPath());
		}
	}
}

const routeView = $derived<CatalogView | null>(
	detailKind === "available" ? "available" : detailKind === "installed" ? "installed" : null,
);
const activeView = $derived(routeView ?? selectedView);
const repositoryLabels = $derived(new Map(repositories.map((repo) => [repo.id, repo.label])));
const repositoriesById = $derived(new Map(repositories.map((repo) => [repo.id, repo])));
const uninstalledAvailableSkills = $derived(availableSkills.filter((skill) => !skill.registered));
const selectedKey = $derived(
	skillId
		? detailKind === "available" && repositoryId
			? `available/${repositoryId}/${skillId}`
			: detailKind === "installed"
				? `installed/${skillId}`
				: null
		: null,
);
const filteredInstalled = $derived.by(() => {
	const needle = query.trim().toLocaleLowerCase();
	return installedSkills.filter((skill) =>
		needle
			? [skill.label, skill.id, skill.description ?? ""]
					.join(" ")
					.toLocaleLowerCase()
					.includes(needle)
			: true,
	);
});
const filteredAvailable = $derived.by(() => {
	const needle = query.trim().toLocaleLowerCase();
	return availableSkills.filter((skill) => {
		if (repositoryFilter !== "all" && skill.repositoryId !== repositoryFilter) return false;
		if (remoteFilter === "available" && skill.registered) return false;
		if (remoteFilter === "updates" && !skill.updateAvailable) return false;
		if (remoteFilter === "invoked" && skill.usage.invokedLast30Days === 0) return false;
		if (remoteFilter === "stale" && !skill.stale) return false;
		if (!needle) return true;
		return [
			skill.label,
			skill.id,
			skill.description ?? "",
			repositoryLabels.get(skill.repositoryId) ?? "",
			skill.repositoryId,
		]
			.join(" ")
			.toLocaleLowerCase()
			.includes(needle);
	});
});
const visibleCount = $derived(
	activeView === "installed" ? filteredInstalled.length : filteredAvailable.length,
);
function skillStatus(skill: SkillCatalogItem | InstalledSkillCatalogItem) {
	if ("stale" in skill && skill.stale) {
		return { label: "No longer available", className: "stale" };
	}
	if (skill.updateAvailable) return { label: "Update available", className: "update" };
	if (!("registered" in skill) || skill.registered) {
		return { label: "Installed", className: "registered" };
	}
	return { label: "Available", className: "" };
}

const detailStatus = $derived(detail ? skillStatus(detail.value) : { label: "", className: "" });

function applyCatalog(catalog: Awaited<ReturnType<typeof fetchSkills>>) {
	repositories = catalog.repositories;
	availableSkills = catalog.availableSkills;
	installedSkills = catalog.installedSkills;
}

async function loadCatalog() {
	loading = installedSkills.length === 0 && availableSkills.length === 0;
	error = null;
	try {
		applyCatalog(await fetchSkills());
	} catch (loadError) {
		error =
			loadError instanceof Error ? loadError.message : "The skill catalog could not be loaded.";
	} finally {
		loading = false;
	}
}

async function refreshCatalog() {
	refreshing = true;
	error = null;
	actionSuccess = null;
	try {
		applyCatalog(await refreshSkills());
		await reloadSelectedDetail();
		actionSuccess =
			repositories.length === 1
				? "Repository refresh complete."
				: `${repositories.length} repository refreshes complete.`;
	} catch (refreshError) {
		error =
			refreshError instanceof Error
				? refreshError.message
				: "Skill repositories could not be refreshed.";
	} finally {
		refreshing = false;
	}
}

async function loadDetail(kind: string, nextRepositoryId: string | null, nextSkillId: string) {
	const token = ++detailRequestToken;
	detailLoading = true;
	detailError = null;
	actionError = null;
	confirmRemove = false;
	detailSection = "overview";
	detail = null;
	try {
		if (kind === "available" && nextRepositoryId) {
			const value = await fetchSkillDetail(nextRepositoryId, nextSkillId);
			if (token === detailRequestToken) detail = { kind: "available", value };
		} else if (kind === "installed") {
			const value = await fetchInstalledSkillDetail(nextSkillId);
			if (token === detailRequestToken) detail = { kind: "installed", value };
		}
	} catch (loadError) {
		if (token !== detailRequestToken) return;
		detailError =
			loadError instanceof Error ? loadError.message : "Skill details could not be loaded.";
	} finally {
		if (token === detailRequestToken) detailLoading = false;
	}
}

async function reloadSelectedDetail() {
	if (detailKind && skillId) await loadDetail(detailKind, repositoryId, skillId);
}

async function activateSkill(sourceRepositoryId?: string | null) {
	const targetRepository = sourceRepositoryId ?? repositoryId;
	if (!targetRepository || !skillId) return;
	const updated = Boolean(detail?.value.updateAvailable);
	actionPending = true;
	actionError = null;
	actionSuccess = null;
	try {
		await registerSkill(targetRepository, skillId);
		await loadCatalog();
		if (detailKind === "installed") {
			await loadDetail("installed", null, skillId);
		} else {
			navigate(buildInstalledSkillPath(skillId));
		}
		actionSuccess = updated ? "Skill updated." : "Skill installed.";
	} catch (actionFailure) {
		actionError =
			actionFailure instanceof Error ? actionFailure.message : "The skill could not be registered.";
	} finally {
		actionPending = false;
	}
}

async function requestRemove() {
	confirmRemove = true;
	await tick();
	confirmRemoveButtonEl?.focus();
}

async function cancelRemove() {
	confirmRemove = false;
	await tick();
	removeButtonEl?.focus();
}

async function deactivateSkill() {
	if (!skillId) return;
	const removedLabel = detail?.value.label ?? skillId;
	actionPending = true;
	actionError = null;
	actionSuccess = null;
	try {
		await removeSkill(skillId);
		confirmRemove = false;
		await loadCatalog();
		navigate(buildSkillsPath());
		actionSuccess = `${removedLabel} removed from future runs.`;
	} catch (actionFailure) {
		actionError =
			actionFailure instanceof Error ? actionFailure.message : "The skill could not be removed.";
	} finally {
		actionPending = false;
	}
}

function instructionMarkdown(markdown: string): string {
	if (!markdown.startsWith("---")) return markdown;
	const end = markdown.indexOf("\n---", 3);
	return end < 0 ? markdown : markdown.slice(end + 4).trimStart();
}

function switchView(view: CatalogView) {
	selectedView = view;
	if (selectedKey) navigate(buildSkillsPath());
}

function handleDetailTabKeydown(event: KeyboardEvent) {
	if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
	event.preventDefault();
	detailSection = detailSection === "overview" ? "instructions" : "overview";
	const tabs = (
		event.currentTarget as HTMLElement
	).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
	void tick().then(() => tabs?.[detailSection === "overview" ? 0 : 1]?.focus());
}

onMount(() => {
	void loadCatalog();
});

$effect(() => {
	const kind = detailKind;
	const id = skillId;
	const repo = repositoryId;
	if (kind && id) {
		void untrack(() => loadDetail(kind, repo, id));
	} else {
		detailRequestToken += 1;
		detail = null;
		detailLoading = false;
	}
});
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

{#snippet skillRow(item: SkillRowItem)}
	{@const skill = item.value}
	{@const available = item.kind === "available"}
	{@const repositoryId = available ? item.value.repositoryId : item.value.sourceRepositoryId}
	{@const registrationKind = available ? null : item.value.registrationKind}
	{@const revision = available ? item.value.sourceRevision : item.value.activeSourceRevision}
	{@const href = available ? buildAvailableSkillPath(item.value.repositoryId, skill.id) : buildInstalledSkillPath(skill.id)}
	{@const selected = selectedKey === `${item.kind}/${available ? `${item.value.repositoryId}/` : ""}${skill.id}`}
	{@const status = skillStatus(skill)}
	{@const repoLabel = registrationKind === "configuration" ? "Configuration" : repositoryLabels.get(repositoryId ?? "") ?? repositoryId ?? "Repository"}
	<tr
		class:selected
		onclick={(event) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest("a, button, select, input")) return;
			followLink(event, href);
		}}
	>
		<td>
			<a {href} onclick={(event) => followLink(event, href)}>
				<strong>{skill.label}</strong>
				<span>{skill.description ?? skill.id}</span>
			</a>
		</td>
		<td>
			<span>{repoLabel}</span>
			<code>
				{repositoryId && repositoryLabels.get(repositoryId) && repositoryLabels.get(repositoryId) !== repositoryId
					? `${repositoryId} · `
					: ""}{revision?.slice(0, 8) ?? "local"}
			</code>
		</td>
		<td>
			<span class={`status-chip ${status.className}`}>{status.label}</span>
			{#if available && item.value.conflict}<span class="conflict">ID conflict</span>{/if}
		</td>
		<td><strong>{skill.usage.attachedLast30Days}</strong><span>30d · {skill.usage.attachedAllTime} total</span></td>
		<td><strong>{skill.usage.invokedLast30Days}</strong><span>30d · {skill.usage.invokedAllTime} total</span></td>
	</tr>
{/snippet}

<div class="skills-page" data-page="skills">
	<section class="catalog-pane" class:with-detail={Boolean(selectedKey)}>
		<PageHeader
			title="Skills"
			subtitle="Manage skills imported into Leitwerk and discover new ones from configured repositories."
		>
			{#snippet actions()}
				{#if repositories.length > 0}
					<button class="page-header-button" type="button" onclick={() => (showRepositoriesModal = true)}>
						Repositories ({repositories.length})
					</button>
				{/if}
			{/snippet}
		</PageHeader>

		{#if actionSuccess && !selectedKey}
			<div class="status-banner success" role="status">{actionSuccess}</div>
		{/if}

		<div class="catalog-tabs" role="group" aria-label="Skill catalog view">
			<button
				type="button"
				data-catalog-view="installed"
				aria-pressed={activeView === "installed"}
				onclick={() => switchView("installed")}
			>
				Installed <span>{installedSkills.length}</span>
			</button>
			<button
				type="button"
				data-catalog-view="available"
				aria-pressed={activeView === "available"}
				onclick={() => switchView("available")}
			>
				Available remotely <span>{uninstalledAvailableSkills.length}</span>
			</button>
		</div>
		<p class="view-explanation">
			{activeView === "installed"
				? "Installed skills are available to attach to new process launches."
				: "Remote skills must be installed before they can be attached to a process."}
		</p>

		<div class="catalog-controls">
			<label class="search-field">
				<span class="sr-only">Search skills</span>
				<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"></circle><path d="m13 13 4 4"></path></svg>
				<input bind:this={searchInputEl} bind:value={query} type="search" placeholder={activeView === "installed" ? "Search installed skills" : "Search remote skills"} />
			</label>
			{#if activeView === "available"}
				<label><span class="sr-only">Repository</span><select bind:value={repositoryFilter}><option value="all">All repositories</option>{#each repositories as repository (repository.id)}<option value={repository.id}>{repository.label !== repository.id ? `${repository.label} (${repository.id})` : repository.label}</option>{/each}</select></label>
				<label><span class="sr-only">Remote skill state</span><select bind:value={remoteFilter}><option value="available">Not installed</option><option value="all">All states</option><option value="updates">Updates available</option><option value="invoked">Invoked in 30 days</option><option value="stale">No longer available</option></select></label>
			{/if}
			<span class="result-count">{visibleCount} {visibleCount === 1 ? "skill" : "skills"}</span>
		</div>

		{#if loading}
			<div class="catalog-state" role="status">Loading the skill catalog…</div>
		{:else if error && installedSkills.length === 0 && availableSkills.length === 0}
			<div class="catalog-state error" role="alert"><strong>We couldn't load the skill catalog.</strong><span>{error}</span></div>
		{:else if activeView === "installed" && installedSkills.length === 0}
			<div class="catalog-state"><strong>No skills are installed.</strong><span>Open Available remotely to install a skill from a configured repository.</span></div>
		{:else if activeView === "available" && repositories.length === 0}
			<div class="catalog-state"><strong>No skill repositories are configured.</strong><span>Add <code>skill_repositories</code> to <code>leitwerk.yaml</code>, then restart Leitwerk.</span></div>
		{:else if activeView === "available" && availableSkills.length === 0}
			<div class="catalog-state"><strong>No remote skills were discovered.</strong><span>Check repository paths and ensure each skill contains a root <code>SKILL.md</code>.</span></div>
		{:else if visibleCount === 0}
			<div class="catalog-state"><strong>No skills match these filters.</strong><span>Clear the search or broaden the selected state.</span></div>
		{:else}
			{#if error}<p class="inline-error" role="status">{error} Showing the last catalog we loaded.</p>{/if}
			<div class="skill-table-wrap">
				<table class="skill-table">
					<thead><tr><th>Skill</th><th>{activeView === "installed" ? "Managed by" : "Repository"}</th><th>Status</th><th>Attached</th><th>Invoked</th></tr></thead>
					<tbody>
						{#if activeView === "installed"}
							{#each filteredInstalled as skill (skill.id)}
								{@render skillRow({ kind: "installed", value: skill })}
							{/each}
						{:else}
							{#each filteredAvailable as skill (`${skill.repositoryId}/${skill.id}`)}
								{@render skillRow({ kind: "available", value: skill })}
							{/each}
						{/if}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	{#if selectedKey}
		<aside class="detail-pane" aria-label="Skill details">
			<div class="mobile-detail-nav">
				<a
					class="mobile-back-button"
					href={buildSkillsPath()}
					onclick={(event) => followLink(event, buildSkillsPath())}
				>
					<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m13 15-5-5 5-5"></path></svg>
					<span>Back to Skills list</span>
				</a>
			</div>
			<a class="detail-close" href={buildSkillsPath()} onclick={(event) => followLink(event, buildSkillsPath())} aria-label="Close skill details"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"></path></svg></a>
			{#if detailLoading}
				<div class="detail-state" role="status">Loading skill details…</div>
			{:else if detailError || !detail}
				<div class="detail-state error" aria-live="polite">{detailError ?? "Skill details are unavailable."}</div>
			{:else}
				<header class="detail-header"><div><h2>{detail.value.label}</h2><p>{detail.value.description ?? detail.value.id}</p></div><span class={`status-chip ${detailStatus.className}`}>{detailStatus.label}</span></header>
				{#if actionSuccess}<div class="status-banner success detail-feedback" role="status">{actionSuccess}</div>{/if}
				{#if detail.kind === "available"}
					<div class="detail-actions"><button class="primary-action" type="button" disabled={actionPending || detail.value.stale || detail.value.conflict || (detail.value.registered && !detail.value.updateAvailable)} onclick={() => void activateSkill()}>{actionPending ? "Working…" : detail.value.updateAvailable ? "Update skill" : detail.value.registered ? "Already installed" : "Install skill"}</button></div>
					{#if detail.value.stale}<p class="action-note warning">This revision was not found during the latest successful repository refresh. It remains visible for history but cannot be installed or updated.</p>{/if}
					{#if detail.value.conflict}<p class="action-note warning">This skill ID conflicts with another repository or a configuration-managed skill. Resolve the conflict before installing it.</p>{/if}
				{:else}
					<div class="detail-actions">
						{#if detail.value.updateAvailable && detail.value.sourceRepositoryId}<button class="primary-action" type="button" disabled={actionPending} onclick={() => void activateSkill(detail.value.sourceRepositoryId)}>{actionPending ? "Updating…" : "Update skill"}</button>{/if}
						{#if detail.value.registrationKind === "catalog"}<button bind:this={removeButtonEl} class="secondary-action danger" type="button" disabled={actionPending} onclick={() => void requestRemove()}>Remove</button>{/if}
					</div>
					{#if detail.value.registrationKind === "configuration"}<p class="action-note">This skill is managed by <code>leitwerk.yaml</code>. Change configuration to remove or update it.</p>{/if}
					{#if confirmRemove}<div class="remove-confirmation" role="group" aria-label={`Remove ${detail.value.label}`}><strong>Remove {detail.value.label} from future runs?</strong><p>Existing processes and schedules keep their pinned revision.</p><div><button bind:this={confirmRemoveButtonEl} class="danger-action" type="button" disabled={actionPending} onclick={() => void deactivateSkill()}>{actionPending ? "Removing…" : "Confirm removal"}</button><button class="secondary-action" type="button" disabled={actionPending} onclick={() => void cancelRemove()}>Cancel</button></div></div>{/if}
				{/if}
				{#if actionError}<p class="action-note error" role="alert">{actionError} Try again.</p>{/if}

				<div class="detail-tabs" role="tablist" aria-label="Skill detail sections">
					<button type="button" role="tab" aria-selected={detailSection === "overview"} aria-controls="skill-overview" tabindex={detailSection === "overview" ? 0 : -1} onclick={() => (detailSection = "overview")} onkeydown={handleDetailTabKeydown}>Overview</button>
					<button type="button" role="tab" aria-selected={detailSection === "instructions"} aria-controls="skill-instructions" tabindex={detailSection === "instructions" ? 0 : -1} onclick={() => (detailSection = "instructions")} onkeydown={handleDetailTabKeydown}>Instructions</button>
				</div>
				{#if detailSection === "overview"}
					<div id="skill-overview" role="tabpanel">
						{#if detail.kind === "available"}
							{@render sourceMetadata(detail.value)}
						{:else}
							<dl class="detail-meta"><div><dt>Managed by</dt><dd>{detail.value.registrationKind === "configuration" ? "Configuration" : repositoryLabels.get(detail.value.sourceRepositoryId ?? "") ?? detail.value.sourceRepositoryId ?? "Repository"}</dd></div><div><dt>Active revision</dt><dd><code>{detail.value.activeSourceRevision ?? detail.value.activeRevisionId}</code></dd></div><div><dt>Usage</dt><dd>{detail.value.usage.attachedAllTime} attached · {detail.value.usage.invokedAllTime} invoked</dd></div></dl>
							<section class="revision-section"><h3>Revision history</h3><div class="revision-list">{#each detail.value.revisions as revision (revision.id)}<div><span><code>{revision.sourceRevision ?? revision.id}</code><small>Imported {formatLocalDateTime(revision.importedAt)}</small></span>{#if revision.active}<span class="status-chip registered">Active</span>{/if}</div>{/each}</div></section>
						{/if}
						{@render processUsage(detail.value.processes)}
					</div>
				{:else}
					<section id="skill-instructions" class="instructions-section" role="tabpanel"><h3>Instructions</h3><ChronicleMarkdown markdown={instructionMarkdown(detail.value.skillMarkdown)} /></section>
				{/if}
			{/if}
		</aside>
	{/if}
</div>

<ModalShell
	open={showRepositoriesModal}
	titleId="repository-modal-title"
	closeLabel="Close configured repositories"
	onClose={() => (showRepositoriesModal = false)}
	dataSection="repository-modal"
>
	<header class="repository-modal-header">
		<h2 id="repository-modal-title">Configured repositories</h2>
		<p>Skill repositories configured in <code>leitwerk.yaml</code>.</p>
	</header>

	{#if actionSuccess}<div class="status-banner success" role="status">{actionSuccess}</div>{/if}
	{#if error}<div class="status-banner error" role="alert">{error} Check the repository configuration and try again.</div>{/if}

	<div class="repository-modal-list">
		{#each repositories as repository (repository.id)}
			<div class:error={Boolean(repository.error)} class:refreshing class="repository-card">
				<div class="repository-card-header">
					<strong>{repository.label !== repository.id ? `${repository.label} (${repository.id})` : repository.label}</strong>
					<span class:error-chip={Boolean(repository.error)} class="repository-sync-chip">
						{refreshing ? "Refreshing…" : repository.error ? "Refresh failed" : repository.lastRefreshedAt ? `Synced ${formatLocalDateTime(repository.lastRefreshedAt)}` : "Not refreshed"}
					</span>
				</div>
				<dl class="repository-card-meta">
					<div><dt>Repository URL</dt><dd><code>{repository.url}</code></dd></div>
					<div><dt>Ref</dt><dd><code>{repository.ref}</code></dd></div>
					<div><dt>Path</dt><dd><code>{repository.path}</code></dd></div>
				</dl>
				{#if repository.error}<p class="repository-card-error" role="alert">{repository.error}</p>{/if}
			</div>
		{/each}
	</div>

	<footer class="repository-modal-footer">
		<button class="secondary-action" type="button" disabled={refreshing || repositories.length === 0} onclick={() => void refreshCatalog()}>{refreshing ? "Refreshing…" : "Refresh all"}</button>
		<button class="primary-action" type="button" onclick={() => (showRepositoriesModal = false)}>Done</button>
	</footer>
</ModalShell>

{#snippet sourceMetadata(skill: SkillCatalogDetail)}
	{@const repository = repositoriesById.get(skill.repositoryId)}
	<dl class="detail-meta"><div><dt>Repository</dt><dd>{repository?.label ?? skill.repositoryId}</dd></div><div><dt>Configured ref</dt><dd><code>{repository?.ref ?? "—"}</code></dd></div><div class="full"><dt>Repository URL</dt><dd><code>{repository?.url ?? "—"}</code></dd></div><div><dt>Source path</dt><dd><code>{skill.sourcePath}</code></dd></div><div><dt>Discovered revision</dt><dd><code>{skill.sourceRevision}</code></dd></div><div><dt>Usage</dt><dd>{skill.usage.attachedAllTime} attached · {skill.usage.invokedAllTime} invoked</dd></div></dl>
{/snippet}

{#snippet processUsage(processes: SkillCatalogDetail["processes"])}
	<section class="usage-section"><h3>Process usage</h3>{#if processes.length === 0}<p>No process has attached this skill yet.</p>{:else}<div class="process-usage-list">{#each processes as process (process.instanceId)}<a href={buildProcessPath(process.instanceId)} onclick={(event) => followLink(event, buildProcessPath(process.instanceId))}><span><strong>{process.title}</strong><small>Attached {formatLocalDateTime(process.attachedAt)}</small></span><span class="invocation-count">{process.invocationCount} {process.invocationCount === 1 ? "invocation" : "invocations"}</span></a>{/each}</div>{/if}</section>
{/snippet}

<style>
	.skills-page { display: grid; grid-template-columns: minmax(0, 1fr) auto; min-height: 0; height: 100%; gap: var(--space-lg); }
	.catalog-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--space-md); padding: var(--space-2xs) 2px var(--space-xl); overflow-y: auto; }
	.catalog-tabs { display: flex; gap: var(--space-2xs); padding: 4px; width: fit-content; border-radius: var(--radius-md); background: var(--chronicle-panel-muted); }
	.catalog-tabs button { min-height: 36px; padding: 0 13px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--chronicle-text-muted); font-weight: 620; cursor: pointer; }
	.catalog-tabs button[aria-pressed="true"] { background: white; color: var(--chronicle-text); box-shadow: 0 3px 10px rgba(24, 33, 43, 0.07); }
	.catalog-tabs span { margin-left: 5px; color: var(--chronicle-text-faint); font-size: var(--type-caption); }
	.view-explanation { margin: calc(-1 * var(--space-xs)) 0 0; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); }
	.status-banner { padding: 10px 12px; border-radius: var(--radius-sm); font-size: var(--type-body-sm); }
	.status-banner.success { background: var(--chronicle-success-surface); color: var(--chronicle-success); }
	.status-banner.error { background: var(--chronicle-danger-surface-soft); color: var(--chronicle-danger-text); }

	.catalog-controls { display: flex; gap: var(--space-xs); align-items: center; }
	.search-field { position: relative; min-width: 220px; flex: 1 1 300px; }
	.search-field svg { position: absolute; left: 12px; top: 50%; width: 17px; height: 17px; transform: translateY(-50%); stroke: var(--chronicle-text-faint); stroke-width: 1.6; fill: none; pointer-events: none; }
	input, select { width: 100%; min-height: 40px; border: 1px solid var(--chronicle-border); border-radius: var(--radius-sm); background: var(--chronicle-bg); color: var(--chronicle-text); padding: 8px 12px; }
	input { padding-left: 38px; }
	.result-count { color: var(--chronicle-text-muted); font-size: var(--type-body-sm); white-space: nowrap; }
	.catalog-state { display: grid; gap: 4px; padding: var(--space-lg); border-radius: var(--radius-md); background: var(--chronicle-panel-muted); color: var(--chronicle-text-muted); }
	.catalog-state strong { color: var(--chronicle-text); }
	.catalog-state.error, .inline-error, .action-note.error { background: var(--chronicle-danger-surface-soft); color: var(--chronicle-danger-text); }
	.inline-error, .action-note { margin: 0; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--chronicle-panel-muted); font-size: var(--type-body-sm); }
	.skill-table-wrap { min-width: 0; overflow-x: clip; }
	.skill-table { width: 100%; border-collapse: collapse; table-layout: fixed; text-align: left; }
	.skill-table th:first-child { width: 31%; }
	.skill-table th:nth-child(2) { width: 22%; }
	.skill-table th:nth-child(3) { width: 19%; }
	.skill-table th:nth-child(4), .skill-table th:nth-child(5) { width: 14%; }
	.skill-table th { padding: 9px 12px; border-bottom: 1px solid var(--chronicle-border); color: var(--chronicle-text-faint); font-size: var(--type-caption); font-weight: 620; }
	.skill-table td { padding: 13px 12px; border-bottom: 1px solid color-mix(in srgb, var(--chronicle-border) 75%, white 25%); vertical-align: middle; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); }
	.skill-table tbody tr { cursor: pointer; transition: background-color 0.15s ease; }
	.skill-table tbody tr:hover { background: var(--chronicle-panel-muted); }
	.skill-table tbody tr:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: -2px; }
	.skill-table tr.selected td { background: var(--chronicle-accent-soft); }
	.skill-table td:first-child { min-width: 230px; }
	.skill-table a { display: grid; gap: 3px; color: inherit; text-decoration: none; }
	.skill-table a:hover strong { color: var(--chronicle-accent); }
	.skill-table td strong { color: var(--chronicle-text); font-size: var(--type-body); font-weight: 650; }
	.skill-table td span, .skill-table td code { display: block; }
	.skill-table code, .detail-meta code, .revision-list code { font-family: var(--font-mono); font-size: var(--type-caption); overflow-wrap: anywhere; }
	.status-chip { display: inline-flex !important; width: fit-content; padding: 5px 9px; border-radius: 999px; background: var(--chronicle-panel-muted); color: var(--chronicle-text-muted); font-size: var(--type-caption); font-weight: 650; white-space: nowrap; }
	.status-chip.registered { background: var(--chronicle-success-surface); color: var(--chronicle-success); }
	.status-chip.update { background: color-mix(in srgb, white 88%, var(--chronicle-attention) 12%); color: var(--chronicle-attention); }
	.status-chip.stale { background: color-mix(in srgb, white 88%, var(--chronicle-danger) 12%); color: var(--chronicle-danger-text); }
	.conflict { margin-top: 5px; color: var(--chronicle-danger-text); font-size: var(--type-caption); }
	.detail-pane { position: relative; width: min(500px, 38vw); min-width: 400px; height: 100%; min-height: 0; padding: var(--space-xl); overflow-y: auto; border-radius: var(--radius-lg); background: var(--chronicle-card-surface-strong); box-shadow: var(--chronicle-shadow); }
	.mobile-detail-nav { display: none; margin-bottom: var(--space-md); }
	.mobile-back-button { display: inline-flex; align-items: center; gap: var(--space-2xs); padding: 6px 12px; border-radius: var(--radius-sm); background: var(--chronicle-panel-muted); color: var(--chronicle-text); font-size: var(--type-body-sm); font-weight: 620; text-decoration: none; }
	.mobile-back-button:hover { background: var(--chronicle-border); }
	.mobile-back-button svg { width: 16px; height: 16px; stroke: currentColor; stroke-width: 2; fill: none; }
	.detail-close { position: absolute; right: var(--space-md); top: var(--space-md); display: grid; place-items: center; width: 34px; height: 34px; border-radius: var(--radius-sm); color: var(--chronicle-text-muted); }
	.detail-close:hover { background: var(--chronicle-panel-muted); color: var(--chronicle-text); }
	.detail-close svg { width: 18px; height: 18px; stroke: currentColor; stroke-width: 1.7; fill: none; }
	.detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-md); padding-right: 38px; }
	.detail-header h2 { margin: 0; font-size: var(--type-title-md); line-height: 1.2; }
	.detail-header p { margin: 5px 0 0; color: var(--chronicle-text-muted); }
	.detail-actions { display: flex; gap: var(--space-xs); margin-top: var(--space-lg); }
	.primary-action, .secondary-action, .danger-action { min-height: 40px; padding: 0 14px; border-radius: 999px; font-weight: 620; cursor: pointer; }
	.primary-action { border: 1px solid var(--chronicle-text); background: var(--chronicle-text); color: white; }
	.secondary-action { border: 1px solid var(--chronicle-border); background: white; color: var(--chronicle-text); }
	.secondary-action.danger, .danger-action { color: var(--chronicle-danger-text); border-color: var(--chronicle-danger-border); }
	.danger-action { background: var(--chronicle-danger); color: white; border: 1px solid var(--chronicle-danger); }
	button:disabled { cursor: default; opacity: 0.56; }
	.detail-feedback { margin-top: var(--space-md); }
	.action-note { margin-top: var(--space-sm); }
	.action-note.warning { background: color-mix(in srgb, white 90%, var(--chronicle-attention) 10%); color: var(--chronicle-attention); }
	.remove-confirmation { display: grid; gap: 7px; margin-top: var(--space-md); padding: var(--space-md); border-radius: var(--radius-md); background: var(--chronicle-danger-surface-soft); color: var(--chronicle-danger-text); }
	.remove-confirmation p { margin: 0; }
	.remove-confirmation > div { display: flex; gap: var(--space-xs); margin-top: 4px; }
	.detail-tabs { display: flex; gap: var(--space-lg); margin-top: var(--space-xl); border-bottom: 1px solid var(--chronicle-border); }
	.detail-tabs button { min-height: 42px; padding: 0 2px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--chronicle-text-muted); font-weight: 650; cursor: pointer; }
	.detail-tabs button[aria-selected="true"] { border-bottom-color: var(--chronicle-accent); color: var(--chronicle-text); }
	.detail-meta { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-md); margin: var(--space-lg) 0; padding: var(--space-md) 0; border-bottom: 1px solid var(--chronicle-border); }
	.detail-meta .full { grid-column: 1 / -1; }
	.detail-meta div { min-width: 0; }
	.detail-meta dt { color: var(--chronicle-text-faint); font-size: var(--type-caption); }
	.detail-meta dd { margin: 3px 0 0; color: var(--chronicle-text); font-size: var(--type-body-sm); }
	.usage-section, .revision-section { margin-top: var(--space-xl); }
	.instructions-section { margin-top: var(--space-lg); max-width: 75ch; }
	.usage-section h3, .instructions-section h3, .revision-section h3 { margin: 0 0 var(--space-sm); font-size: var(--type-title-sm); }
	.usage-section > p { color: var(--chronicle-text-muted); }
	.process-usage-list, .revision-list { display: grid; }
	.process-usage-list a, .revision-list > div { display: flex; justify-content: space-between; gap: var(--space-md); padding: 11px 0; border-bottom: 1px solid var(--chronicle-border); color: inherit; text-decoration: none; }
	.process-usage-list a:hover strong { color: var(--chronicle-accent); }
	.process-usage-list span:first-child, .revision-list span:first-child { display: grid; gap: 2px; }
	.process-usage-list strong { color: var(--chronicle-text); font-size: var(--type-body-sm); }
	.process-usage-list small, .revision-list small, .invocation-count { color: var(--chronicle-text-muted); font-size: var(--type-caption); }
	.invocation-count { flex: 0 0 auto; }
	.detail-state { padding: var(--space-xl); color: var(--chronicle-text-muted); }
	.detail-state.error { color: var(--chronicle-danger-text); }
	.repository-modal-header h2 { margin: 0; font-size: var(--type-title-md); }
	.repository-modal-header p { margin: 4px 0 0; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); }
	.repository-modal-list { flex: 1 1 auto; overflow-y: auto; display: grid; gap: var(--space-sm); padding-right: 2px; }
	.repository-card { display: grid; gap: var(--space-xs); padding: var(--space-md); border: 1px solid var(--chronicle-border); border-radius: var(--radius-md); background: var(--chronicle-panel-muted); }
	.repository-card.error { border-color: var(--chronicle-danger-border); background: var(--chronicle-danger-surface-soft); }
	.repository-card-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
	.repository-card-header strong { color: var(--chronicle-text); font-size: var(--type-body); font-weight: 650; }
	.repository-sync-chip { font-size: var(--type-caption); color: var(--chronicle-text-muted); font-weight: 600; }
	.repository-sync-chip.error-chip { color: var(--chronicle-danger-text); }
	.repository-card-meta { display: grid; grid-template-columns: 1fr auto auto; gap: var(--space-xs) var(--space-md); margin: 0; }
	.repository-card-meta dt { color: var(--chronicle-text-faint); font-size: var(--type-caption); }
	.repository-card-meta dd { margin: 2px 0 0; font-size: var(--type-body-sm); color: var(--chronicle-text); }
	.repository-card-error { margin: 0; color: var(--chronicle-danger-text); font-size: var(--type-body-sm); word-break: break-word; }
	.repository-modal-footer { display: flex; justify-content: flex-end; gap: var(--space-xs); padding-top: var(--space-sm); border-top: 1px solid var(--chronicle-border); }
	@media (max-width: 1320px) { .skills-page { display: block; height: auto; min-height: 100%; } .catalog-pane.with-detail { display: none; } .detail-pane { width: 100%; min-width: 0; min-height: calc(100dvh - 2 * var(--space-lg)); height: auto; overflow: visible; border-radius: var(--radius-lg); box-shadow: none; } .mobile-detail-nav { display: flex; } }
	@media (max-width: 960px) { .detail-pane { min-height: calc(100dvh - 28px); border-radius: 0; } }
	@media (max-width: 760px) { .catalog-controls { display: grid; grid-template-columns: 1fr 1fr; } .search-field, .result-count { grid-column: 1 / -1; } .result-count { justify-self: start; } .catalog-tabs { width: 100%; } .catalog-tabs button { flex: 1 1 50%; } .skill-table { table-layout: auto; } .skill-table th:first-child { width: auto; } .skill-table th:nth-child(3) { width: 132px; } .skill-table th:nth-child(2), .skill-table td:nth-child(2), .skill-table th:nth-child(4), .skill-table td:nth-child(4), .skill-table th:nth-child(5), .skill-table td:nth-child(5) { display: none; } .skill-table td:first-child { min-width: 0; } .detail-pane { padding: var(--space-lg); } .detail-close { display: none; } .detail-meta { grid-template-columns: 1fr; } .detail-meta .full { grid-column: auto; } }
	@media (max-width: 430px) { .catalog-controls { grid-template-columns: 1fr; } .catalog-controls > * { grid-column: 1; } .skill-table th, .skill-table td { padding-left: 8px; padding-right: 8px; } .skill-table th:nth-child(3) { width: 116px; } .detail-actions, .remove-confirmation > div, .repository-modal-footer { flex-wrap: wrap; } }
</style>

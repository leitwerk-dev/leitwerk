<script lang="ts">
import type { Actor } from "@leitwerk-dev/domain";
import { type FutureActionSummary, type FutureExecutionSummary, logout } from "../lib/api.js";

import { formatLocalDateTime, formatLocalDateTime24Hour } from "../lib/format.js";
import { openKeyboardShortcutHelp } from "../lib/keyboard-shortcuts-help.js";
import type { ProcessRowView } from "../lib/process-row-view.js";
import {
	futureExecutions,
	listState,
	loadProcessesList,
	processRows,
} from "../lib/processes.svelte";
import type { Route } from "../lib/router.svelte";
import {
	buildFutureLaunchPath,
	buildHomePath,
	buildProcessesPath,
	buildProcessPath,
	buildSkillsPath,
	buildWatchersPath,
	followLink,
	navigate,
} from "../lib/router.svelte";
import { wsStore } from "../lib/ws.svelte";

interface Props {
	currentRoute: Route;
	authEnabled: boolean;
	actor: Actor;
	onLoggedOut?: () => void;
}

const collapseBreakpointPx = 960;

let {
	currentRoute,
	authEnabled,
	actor,
	onLoggedOut = () => window.location.assign("/"),
}: Props = $props();

const homePath = buildHomePath();
const processesPath = buildProcessesPath();
const watchersPath = buildWatchersPath();
const skillsPath = buildSkillsPath();
const futureActionInstanceIds = $derived(
	new Set(
		$futureExecutions
			.filter((execution): execution is FutureActionSummary => execution.kind === "action")
			.map((execution) => execution.instanceId),
	),
);
const currentRows = $derived(
	$processRows.filter(
		(row) => row.statusCategory !== "terminal" && !futureActionInstanceIds.has(row.instanceId),
	),
);
const waitingRows = $derived(
	currentRows.filter((row) => row.statusCategory === "waiting" || row.statusCategory === "error"),
);
const runningRows = $derived(
	currentRows.filter((row) => row.statusCategory !== "waiting" && row.statusCategory !== "error"),
);
const futureRows = $derived($futureExecutions);
let observedReconnectCount = $state<number | null>(null);
let sidebarCollapsed = $state(false);
let currentProcessesPopoverOpen = $state(false);
let futureExecutionsPopoverOpen = $state(false);
let userPopoverOpen = $state(false);
let logoutPending = $state(false);
let logoutError = $state<string | null>(null);
let collapseSupported = $state(
	typeof window === "undefined" ? true : window.innerWidth > collapseBreakpointPx,
);
let observedRouteKey = $state<string | null>(null);
let currentProcessesTriggerRef = $state<HTMLButtonElement | null>(null);
let currentProcessesPopoverRef = $state<HTMLDivElement | null>(null);
let futureExecutionsTriggerRef = $state<HTMLButtonElement | null>(null);
let futureExecutionsPopoverRef = $state<HTMLDivElement | null>(null);
let userTriggerRef = $state<HTMLButtonElement | null>(null);
let userPopoverRef = $state<HTMLDivElement | null>(null);

const connectionIssue = $derived.by(() => {
	if ($listState.error) {
		return $listState.error;
	}
	if ($wsStore.status === "connecting" && $wsStore.reconnectCount > 0) {
		return "Trying to reconnect to the server…";
	}
	if (
		$wsStore.status === "disconnected" &&
		($wsStore.serverVersion !== null || $wsStore.reconnectCount > 0)
	) {
		return "Connection lost. We'll keep trying to reconnect.";
	}
	return null;
});
const effectiveSidebarCollapsed = $derived(collapseSupported && sidebarCollapsed);
const currentProcessesControlActive = $derived(
	effectiveSidebarCollapsed &&
		(currentProcessesPopoverOpen || currentRoute.page === "process-detail"),
);
const futureExecutionsControlActive = $derived(
	effectiveSidebarCollapsed &&
		(futureExecutionsPopoverOpen || currentRoute.page === "future-launch-detail"),
);
const userName = $derived(authEnabled ? (actor.displayName ?? actor.id) : "Anonymous");

$effect(() => {
	const reconnectCount = $wsStore.reconnectCount;
	if (observedReconnectCount === reconnectCount) {
		return;
	}
	observedReconnectCount = reconnectCount;
	void loadProcessesList();
});

$effect(() => {
	if (typeof window === "undefined") {
		return;
	}

	const updateCollapseSupport = () => {
		collapseSupported = window.innerWidth > collapseBreakpointPx;
	};

	updateCollapseSupport();
	window.addEventListener("resize", updateCollapseSupport);
	return () => {
		window.removeEventListener("resize", updateCollapseSupport);
	};
});

$effect(() => {
	if (collapseSupported) {
		return;
	}
	sidebarCollapsed = false;
	currentProcessesPopoverOpen = false;
	futureExecutionsPopoverOpen = false;
	userPopoverOpen = false;
});

$effect(() => {
	if (effectiveSidebarCollapsed) {
		return;
	}
	currentProcessesPopoverOpen = false;
	futureExecutionsPopoverOpen = false;
	userPopoverOpen = false;
});

$effect(() => {
	const routeKey = `${currentRoute.page}:${currentRoute.params.instanceId ?? ""}:${currentRoute.params.futureExecutionId ?? ""}`;
	if (observedRouteKey === routeKey) {
		return;
	}
	observedRouteKey = routeKey;
	currentProcessesPopoverOpen = false;
	futureExecutionsPopoverOpen = false;
	userPopoverOpen = false;
});

$effect(() => {
	if (!currentProcessesPopoverOpen && !futureExecutionsPopoverOpen && !userPopoverOpen) {
		return;
	}

	const handleDocumentClick = (event: MouseEvent) => {
		const target = event.target as Node | null;
		if (!target) {
			currentProcessesPopoverOpen = false;
			futureExecutionsPopoverOpen = false;
			userPopoverOpen = false;
			return;
		}
		if (
			currentProcessesPopoverRef?.contains(target) ||
			futureExecutionsPopoverRef?.contains(target) ||
			userPopoverRef?.contains(target)
		) {
			return;
		}
		if (
			currentProcessesTriggerRef?.contains(target) ||
			futureExecutionsTriggerRef?.contains(target) ||
			userTriggerRef?.contains(target)
		) {
			return;
		}
		currentProcessesPopoverOpen = false;
		futureExecutionsPopoverOpen = false;
		userPopoverOpen = false;
	};

	const handleDocumentKeydown = (event: KeyboardEvent) => {
		if (event.key !== "Escape") {
			return;
		}
		const focusTarget = currentProcessesPopoverOpen
			? currentProcessesTriggerRef
			: futureExecutionsPopoverOpen
				? futureExecutionsTriggerRef
				: userTriggerRef;
		currentProcessesPopoverOpen = false;
		futureExecutionsPopoverOpen = false;
		userPopoverOpen = false;
		focusTarget?.focus();
	};

	document.addEventListener("click", handleDocumentClick, true);
	document.addEventListener("keydown", handleDocumentKeydown);
	return () => {
		document.removeEventListener("click", handleDocumentClick, true);
		document.removeEventListener("keydown", handleDocumentKeydown);
	};
});

function processPath(instanceId: string): string {
	return buildProcessPath(instanceId);
}

function isSelectedRow(row: ProcessRowView): boolean {
	return (
		currentRoute.page === "process-detail" && currentRoute.params.instanceId === row.instanceId
	);
}

function stateKind(row: ProcessRowView): string {
	if (row.lifecycleStatus === "error") {
		return "error";
	}
	switch (row.statusCategory) {
		case "waiting":
			return "waiting";
		case "active":
			return "running";
		case "terminal":
			return row.lifecycleStatus === "completed" ? "completed" : "aborted";
		default:
			return "discovered";
	}
}

function metaLine(row: ProcessRowView): string {
	return row.turnLabel ? `${row.turnLabel} · ${row.processDisplayName}` : row.processDisplayName;
}

function futurePath(item: FutureExecutionSummary): string {
	if (item.kind === "action") {
		return processPath(item.instanceId);
	}
	return buildFutureLaunchPath(item.id);
}

function isSelectedFutureItem(item: FutureExecutionSummary): boolean {
	if (item.kind === "action") {
		return (
			currentRoute.page === "process-detail" && currentRoute.params.instanceId === item.instanceId
		);
	}
	return (
		currentRoute.page === "future-launch-detail" &&
		currentRoute.params.futureExecutionId === item.id
	);
}

function futureRowStatusLabel(item: FutureExecutionSummary): string {
	if (item.status === "blocked") return "Blocked";
	if (item.kind === "action") {
		return "Scheduled action";
	}
	return item.scheduleKind === "cron" ? "Recurring cron" : "Scheduled start";
}

function futureRowMeta(item: FutureExecutionSummary): string | null {
	return item.kind === "action" ? item.actionLabel : null;
}

function futureStatusLine(item: FutureExecutionSummary): string {
	const meta = futureRowMeta(item);
	return meta ? `${futureRowStatusLabel(item)} · ${meta}` : futureRowStatusLabel(item);
}

function futureRowSecondary(item: FutureExecutionSummary): string {
	if (item.blockedReason?.summary) return item.blockedReason.summary;
	const timeLabel =
		item.kind === "action"
			? formatLocalDateTime24Hour(item.nextRunAt)
			: formatLocalDateTime(item.nextRunAt);
	if (item.scheduleKind === "cron" && item.cronExpression) {
		return `${timeLabel} · ${item.cronExpression}`;
	}
	return timeLabel;
}

function futureStateKind(item: FutureExecutionSummary): string {
	if (item.kind === "action") {
		return "future-action";
	}
	if (item.scheduleKind === "cron") {
		return "future-cron";
	}
	return "future-once";
}

function openFutureItem(item: FutureExecutionSummary, event: MouseEvent) {
	event.preventDefault();
	futureExecutionsPopoverOpen = false;
	navigate(futurePath(item));
}

function closePopovers() {
	currentProcessesPopoverOpen = false;
	futureExecutionsPopoverOpen = false;
	userPopoverOpen = false;
}

function toggleSidebar() {
	if (!collapseSupported) {
		return;
	}
	sidebarCollapsed = !sidebarCollapsed;
	closePopovers();
}

function openSidebar() {
	sidebarCollapsed = false;
	closePopovers();
}

function toggleCurrentProcessesPopover() {
	if (!effectiveSidebarCollapsed) {
		return;
	}
	currentProcessesPopoverOpen = !currentProcessesPopoverOpen;
	futureExecutionsPopoverOpen = false;
	userPopoverOpen = false;
}

function toggleFutureExecutionsPopover() {
	if (!effectiveSidebarCollapsed) {
		return;
	}
	futureExecutionsPopoverOpen = !futureExecutionsPopoverOpen;
	currentProcessesPopoverOpen = false;
	userPopoverOpen = false;
}

function toggleUserPopover() {
	userPopoverOpen = !userPopoverOpen;
	currentProcessesPopoverOpen = false;
	futureExecutionsPopoverOpen = false;
	logoutError = null;
}

function showHelp() {
	userPopoverOpen = false;
	openKeyboardShortcutHelp();
}

async function logOut() {
	if (logoutPending) return;
	logoutPending = true;
	logoutError = null;
	try {
		await logout();
		onLoggedOut();
	} catch {
		logoutError = "Couldn't log out. Try again.";
	} finally {
		logoutPending = false;
	}
}

function openCurrentProcessRow(row: ProcessRowView, event: MouseEvent) {
	currentProcessesPopoverOpen = false;
	followLink(event, processPath(row.instanceId));
}
</script>

{#snippet processRowList(rows: readonly ProcessRowView[], extraListClass = "")}
	<div class="process-list {extraListClass}">
		{#each rows as row (row.instanceId)}
			{@const href = processPath(row.instanceId)}
			<a
				href={href}
				class="process-row"
				class:is-selected={isSelectedRow(row)}
				aria-current={isSelectedRow(row) ? "page" : undefined}
				data-pressable="true"
				title={`${row.title} — ${row.statusLine}`}
				onclick={(event) => openCurrentProcessRow(row, event)}
			>
				<span class="row-copy">
					<span class="row-title">{row.title}</span>
					<span class="row-status-line">
						<span class="row-meta">
							<span class={`row-status-text ${stateKind(row)}`}>{row.statusLabel}</span> · {metaLine(row)}
						</span>
					</span>
				</span>
			</a>
		{/each}
	</div>
{/snippet}

{#snippet futureRowList(items: readonly FutureExecutionView[], extraListClass = "")}
	<div class="process-list {extraListClass}">
		{#each items as item (item.id)}
			{@const href = futurePath(item)}
			{@const itemMeta = futureRowMeta(item)}
			<a
				href={href}
				class="process-row future-row"
				class:is-selected={isSelectedFutureItem(item)}
				aria-current={isSelectedFutureItem(item) ? "page" : undefined}
				data-pressable="true"
				title={`${item.title} — ${futureStatusLine(item)}`}
				onclick={(event) => openFutureItem(item, event)}
			>
				<span class="row-copy">
					<span class="row-title">{item.title}</span>
					<span class="row-status-line">
						<span class="row-meta">
							<span class={`row-status-text ${futureStateKind(item)}`}>{futureRowStatusLabel(item)}</span>{#if itemMeta} · {itemMeta}{/if}
						</span>
					</span>
					<span class="row-secondary">{futureRowSecondary(item)}</span>
				</span>
			</a>
		{/each}
	</div>
{/snippet}

<aside
	class="sidebar"
	data-column="sidebar"
	data-sidebar-state={effectiveSidebarCollapsed ? "collapsed" : "expanded"}
>
	{#if effectiveSidebarCollapsed}
		<div class="collapsed-rail">
			<button
				type="button"
				class="rail-icon-control"
				data-action="toggle-sidebar"
				data-pressable="true"
				aria-label="Open sidebar"
				title="Open sidebar"
				onclick={openSidebar}
			>
				<span class="rail-control-icon" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
						<rect x="3.5" y="4.5" width="17" height="15" rx="2"></rect>
						<path d="M8.5 4.5v15"></path>
						<path d="M14.5 12h4"></path>
						<path d="M16.5 10l2 2-2 2"></path>
					</svg>
				</span>
				<span class="rail-control-label">Open</span>
			</button>

			<a
				href={homePath}
				class="rail-icon-control"
				data-action="create-process"
				data-pressable="true"
				class:is-active={currentRoute.page === "home"}
				aria-current={currentRoute.page === "home" ? "page" : undefined}
				aria-label="Start process"
				title="Start process"
				onclick={(event) => followLink(event, homePath)}
			>
				<span class="rail-control-icon" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="8"></circle>
						<path d="M12 8v8"></path>
						<path d="M8 12h8"></path>
					</svg>
				</span>
				<span class="rail-control-label">New</span>
			</a>

			<a
				href={watchersPath}
				class="rail-icon-control"
				data-action="view-watchers"
				data-pressable="true"
				class:is-active={currentRoute.page === "watchers"}
				aria-current={currentRoute.page === "watchers" ? "page" : undefined}
				aria-label="Watchers"
				title="Watchers"
				onclick={(event) => followLink(event, watchersPath)}
			>
				<span class="rail-control-icon" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
						<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"></path>
						<circle cx="12" cy="12" r="2.5"></circle>
					</svg>
				</span>
				<span class="rail-control-label">Watch</span>
			</a>

			<a
				href={processesPath}
				class="rail-icon-control"
				data-action="view-all-processes"
				data-pressable="true"
				class:is-active={currentRoute.page === "processes"}
				aria-current={currentRoute.page === "processes" ? "page" : undefined}
				aria-label="All processes"
				title="All processes"
				onclick={(event) => followLink(event, processesPath)}
			>
				<span class="rail-control-icon" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
						<path d="M5 5.5h14"></path>
						<path d="M5 12h14"></path>
						<path d="M5 18.5h9"></path>
						<path d="M17 17l2 2 2-2"></path>
					</svg>
				</span>
				<span class="rail-control-label">All</span>
			</a>

			<div class="current-processes-anchor">
				<button
					type="button"
					class="rail-icon-control"
					class:is-active={currentProcessesControlActive}
					class:has-issue={Boolean(connectionIssue)}
					data-action="current-processes"
					data-pressable="true"
					aria-haspopup="dialog"
					aria-controls="current-processes-popover"
					aria-expanded={currentProcessesPopoverOpen}
					aria-label="Waiting and running processes"
					title={connectionIssue ? `Waiting and running processes — ${connectionIssue}` : "Waiting and running processes"}
					bind:this={currentProcessesTriggerRef}
					onclick={toggleCurrentProcessesPopover}
				>
					<span class="rail-control-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
							<path d="M5 7.5h14"></path>
							<path d="M5 12h14"></path>
							<path d="M5 16.5h10"></path>
							<circle cx="17" cy="16.5" r="1.6" fill="currentColor" stroke="none"></circle>
						</svg>
					</span>
					<span class="rail-control-label">Work</span>
				</button>

				{#if currentProcessesPopoverOpen}
					<div
						id="current-processes-popover"
						class="current-processes-popover"
						data-section="current-processes-popover"
						role="dialog"
						aria-modal="false"
						aria-label="Waiting and running processes"
						bind:this={currentProcessesPopoverRef}
					>
						<div class="popover-header">
							<p class="popover-eyebrow">Quick switch</p>
							<h2>Waiting and running</h2>
						</div>

						{#if connectionIssue}
							<p class="group-error popover-error" role="status">{connectionIssue}</p>
						{/if}

						<div class="popover-scroll">
							{#if $listState.loading && currentRows.length === 0}
								<div class="empty-state">Loading active processes…</div>
							{:else if currentRows.length === 0}
								<div class="empty-state">No waiting or running processes. Start one above and it will appear here.</div>
							{:else}
								<div class="popover-section">
									<div class="group-header compact">
										<div class="group-heading">Waiting</div>
										<span class="group-count" aria-label={`${waitingRows.length} waiting process${waitingRows.length === 1 ? "" : "es"}`}>{waitingRows.length}</span>
									</div>
									{#if waitingRows.length === 0}
										<div class="empty-state">No waiting processes.</div>
									{:else}
										{@render processRowList(waitingRows, "popover-process-list")}
									{/if}
								</div>
								<div class="popover-section">
									<div class="group-header compact">
										<div class="group-heading">Running</div>
										<span class="group-count" aria-label={`${runningRows.length} running process${runningRows.length === 1 ? "" : "es"}`}>{runningRows.length}</span>
									</div>
									{#if runningRows.length === 0}
										<div class="empty-state">No running processes.</div>
									{:else}
										{@render processRowList(runningRows, "popover-process-list")}
									{/if}
								</div>
							{/if}
						</div>
					</div>
				{/if}
			</div>

			<div class="current-processes-anchor">
				<button
					type="button"
					class="rail-icon-control"
					class:is-active={futureExecutionsControlActive}
					data-action="future-executions"
					data-pressable="true"
					aria-haspopup="dialog"
					aria-controls="future-executions-popover"
					aria-expanded={futureExecutionsPopoverOpen}
					aria-label="Future scheduled work"
					title="Future scheduled work"
					bind:this={futureExecutionsTriggerRef}
					onclick={toggleFutureExecutionsPopover}
				>
					<span class="rail-control-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
							<path d="M7 3.5v3"></path>
							<path d="M17 3.5v3"></path>
							<rect x="4" y="5.5" width="16" height="15" rx="2.5"></rect>
							<path d="M4 9.5h16"></path>
							<path d="M8 14h4"></path>
						</svg>
					</span>
					<span class="rail-control-label">Future</span>
				</button>

				{#if futureExecutionsPopoverOpen}
					<div
						id="future-executions-popover"
						class="current-processes-popover"
						data-section="future-executions-popover"
						role="dialog"
						aria-modal="false"
						aria-label="Future scheduled work"
						bind:this={futureExecutionsPopoverRef}
					>
						<div class="popover-header">
							<p class="popover-eyebrow">Scheduled</p>
							<h2>Future</h2>
						</div>

						<div class="popover-scroll">
							{#if futureRows.length === 0}
								<div class="empty-state">Scheduled starts, cron jobs, and delayed actions will appear here.</div>
							{:else}
								{@render futureRowList(futureRows, "popover-process-list")}
							{/if}
						</div>
					</div>
				{/if}
			</div>
		</div>
	{:else}
		<div class="sidebar-header">
			<div class="sidebar-topbar">
				<a href={homePath} class="sidebar-brand" onclick={(event) => followLink(event, homePath)}>
					Leitwerk
				</a>
				{#if collapseSupported}
					<button
						type="button"
						class="sidebar-collapse-button rail-icon-control"
						data-action="toggle-sidebar"
						data-pressable="true"
						aria-label="Collapse sidebar"
						title="Collapse sidebar"
						onclick={toggleSidebar}
					>
						<span class="rail-control-icon" aria-hidden="true">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
								<rect x="3.5" y="4.5" width="17" height="15" rx="2"></rect>
								<path d="M8.5 4.5v15"></path>
								<path d="M14.5 12h4"></path>
								<path d="M16.5 10l-2 2 2 2"></path>
							</svg>
						</span>
					</button>
				{/if}
			</div>

			<nav class="sidebar-primary-nav" aria-label="Primary sidebar">
				<a
					href={homePath}
					class="sidebar-nav-link"
					data-action="create-process"
					data-pressable="true"
					class:is-active={currentRoute.page === "home"}
					aria-current={currentRoute.page === "home" ? "page" : undefined}
					onclick={(event) => followLink(event, homePath)}
				>
					<span class="sidebar-nav-icon" aria-hidden="true">+</span>
					<span class="sidebar-nav-label">Start a process</span>
				</a>
				<a
					href={processesPath}
					class="sidebar-nav-link"
					class:is-active={currentRoute.page === "processes"}
					data-action="view-all-processes"
					data-pressable="true"
					aria-current={currentRoute.page === "processes" ? "page" : undefined}
					onclick={(event) => followLink(event, processesPath)}
				>
					<span class="sidebar-nav-icon" aria-hidden="true">⌘</span>
					<span class="sidebar-nav-label">All processes</span>
				</a>
				<a
					href={skillsPath}
					class="sidebar-nav-link"
					data-action="view-skills"
					data-pressable="true"
					class:is-active={currentRoute.page === "skills"}
					aria-current={currentRoute.page === "skills" ? "page" : undefined}
					onclick={(event) => followLink(event, skillsPath)}
				>
					<span class="sidebar-nav-icon" aria-hidden="true">
						<svg viewBox="0 0 20 20" fill="none">
							<path d="M4 5.5h12M4 10h12M4 14.5h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
						</svg>
					</span>
					<span class="sidebar-nav-label">Skills</span>
				</a>
				<a
					href={watchersPath}
					class="sidebar-nav-link"
					data-action="view-watchers"
					data-pressable="true"
					class:is-active={currentRoute.page === "watchers"}
					aria-current={currentRoute.page === "watchers" ? "page" : undefined}
					onclick={(event) => followLink(event, watchersPath)}
				>
					<span class="sidebar-nav-icon" aria-hidden="true">◌</span>
					<span class="sidebar-nav-label">Watchers</span>
				</a>
			</nav>
		</div>

		<div class="sidebar-scroll">
			<section class="process-group future-group" class:is-empty={futureRows.length === 0}>
				<div class="group-header">
					<div class="group-heading">Future</div>
					<span class="group-count" aria-label={`${futureRows.length} future scheduled work item${futureRows.length === 1 ? "" : "s"}`}>
						{futureRows.length}
					</span>
				</div>
				{#if futureRows.length === 0}
					<div class="empty-state">Scheduled starts, cron jobs, and delayed actions will appear here.</div>
				{:else}
					{@render futureRowList(futureRows)}
				{/if}
			</section>

			<section class="process-group waiting-group" class:is-empty={waitingRows.length === 0}>
				<div class="group-header">
					<div class="group-heading">Waiting</div>
					<span class="group-count" aria-label={`${waitingRows.length} waiting process${waitingRows.length === 1 ? "" : "es"}`}>
						{waitingRows.length}
					</span>
				</div>
				{#if $listState.loading && currentRows.length === 0}
					<div class="empty-state">Loading active processes…</div>
				{:else if currentRows.length === 0}
					<div class="empty-state">No waiting or running processes. Start one above and it will appear here.</div>
				{:else if waitingRows.length === 0}
					<div class="empty-state">No waiting processes.</div>
				{:else}
					{@render processRowList(waitingRows)}
				{/if}
			</section>

			<section class="process-group running-group" class:is-empty={runningRows.length === 0}>
				<div class="group-header">
					<div class="group-heading">Running</div>
					<span class="group-count" aria-label={`${runningRows.length} running process${runningRows.length === 1 ? "" : "es"}`}>
						{runningRows.length}
					</span>
				</div>
				{#if runningRows.length === 0}
					<div class="empty-state">No running processes.</div>
				{:else}
					{@render processRowList(runningRows)}
				{/if}
			</section>
		</div>
	{/if}

	{#if connectionIssue && !effectiveSidebarCollapsed}
		<div class="connection-overlay" role="status" aria-live="polite">
			<p class="overlay-title">Connection issue</p>
			<p class="overlay-copy">{connectionIssue}</p>
		</div>
	{/if}

	<div class="sidebar-footer" class:is-collapsed={effectiveSidebarCollapsed}>
			<button
				type="button"
				class="user-trigger"
				class:is-collapsed={effectiveSidebarCollapsed}
				data-action="user-menu"
				data-pressable="true"
				aria-haspopup="dialog"
				aria-controls="user-menu-popover"
				aria-expanded={userPopoverOpen}
				aria-label={`User menu for ${userName}`}
				title={userName}
				bind:this={userTriggerRef}
				onclick={toggleUserPopover}
			>
				<span class="footer-icon" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="8" r="3.25"></circle>
						<path d="M5.5 19c.7-3.4 3-5.25 6.5-5.25s5.8 1.85 6.5 5.25"></path>
					</svg>
				</span>
				{#if !effectiveSidebarCollapsed}<span class="user-name">{userName}</span>{/if}
			</button>

			{#if userPopoverOpen}
				<div
					id="user-menu-popover"
					class="user-popover"
					class:is-collapsed={effectiveSidebarCollapsed}
					data-section="user-menu-popover"
					role="dialog"
					aria-modal="false"
					aria-label={`User options for ${userName}`}
					bind:this={userPopoverRef}
				>
					<a class="user-popover-action" href="/account/api-tokens" onclick={(event) => { userPopoverOpen = false; followLink(event, "/account/api-tokens"); }}>API tokens</a>
 <button type="button" class="user-popover-action" onclick={showHelp}>Show help</button>
 {#if authEnabled}
					<button
						type="button"
						class="user-popover-action"
						disabled={logoutPending}
						onclick={logOut}
					>
						{logoutPending ? "Logging out…" : "Log out"}
					</button>
					{#if logoutError}<p class="logout-error" role="alert">{logoutError}</p>{/if}
 {/if}
				</div>
			{/if}
	</div>
</aside>

<style>
	.sidebar {
		--sidebar-expanded-width: clamp(260px, 25vw, 300px);
		--sidebar-collapsed-width: 64px;
		display: flex;
		flex: 0 0 var(--sidebar-expanded-width);
		flex-direction: column;
		width: var(--sidebar-expanded-width);
		min-width: 250px;
		max-width: 300px;
		height: 100%;
		min-height: 0;
		padding: 16px var(--space-xs) 20px;
		border-right: 1px solid var(--chronicle-border);
		background: var(--chronicle-sidebar-surface);
		position: relative;
		overflow: hidden;
		transition: background-color var(--duration-fast) var(--ease-out-quart);
	}

	.sidebar[data-sidebar-state="collapsed"] {
		flex-basis: var(--sidebar-collapsed-width);
		width: var(--sidebar-collapsed-width);
		min-width: var(--sidebar-collapsed-width);
		max-width: var(--sidebar-collapsed-width);
		padding: 16px 8px;
		overflow: visible;
		align-items: center;
		z-index: 2;
	}

	.sidebar-header {
		display: grid;
		gap: 12px;
		margin-bottom: 18px;
	}

	.sidebar-topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.sidebar-brand {
		min-width: 0;
		color: var(--chronicle-text);
		font-family: var(--font-display);
		font-size: 1.3rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		text-decoration: none;
	}

	.sidebar-brand:hover {
		color: color-mix(in srgb, var(--chronicle-text) 82%, var(--chronicle-accent) 18%);
	}

	.rail-icon-control {
		display: grid;
		grid-template-rows: 20px auto;
		place-items: center;
		gap: 2px;
		width: 48px;
		min-height: 48px;
		padding: 5px 2px 4px;
		border: 1px solid transparent;
		border-radius: 12px;
		background: transparent;
		color: var(--chronicle-text-faint);
		text-decoration: none;
		cursor: pointer;
		position: relative;
	}

	.rail-icon-control:hover,
	.rail-icon-control.is-active,
	.rail-icon-control[aria-expanded="true"] {
		border-color: color-mix(in srgb, var(--chronicle-border) 72%, transparent 28%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 78%, transparent 22%);
		color: var(--chronicle-text);
	}

	.rail-icon-control.is-active,
	.rail-icon-control[aria-expanded="true"] {
		border-color: color-mix(in srgb, var(--chronicle-accent) 24%, var(--chronicle-border) 76%);
		background: color-mix(in srgb, var(--chronicle-accent) 9%, var(--chronicle-card-surface) 91%);
	}

	.sidebar-collapse-button {
		grid-template-rows: 1fr;
	}

	.rail-control-icon,
	.rail-icon-control svg {
		width: 19px;
		height: 19px;
	}

	.rail-control-label {
		max-width: 44px;
		overflow: hidden;
		color: currentColor;
		font-size: 0.625rem;
		font-weight: 650;
		line-height: 1;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rail-icon-control.has-issue::after {
		content: "";
		position: absolute;
		top: 5px;
		right: 6px;
		width: 6px;
		height: 6px;
		border-radius: 999px;
		background: var(--chronicle-danger);
		box-shadow: 0 0 0 1.5px var(--chronicle-sidebar-surface);
	}

	.sidebar-primary-nav {
		display: grid;
		gap: 4px;
	}

	.sidebar-nav-link {
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr);
		gap: 10px;
		align-items: center;
		min-height: 38px;
		padding: 7px 9px;
		border: 1px solid transparent;
		border-radius: 12px;
		color: var(--chronicle-text-muted);
		text-decoration: none;
	}

	.sidebar-nav-link:hover,
	.sidebar-nav-link.is-active {
		background: color-mix(in srgb, var(--chronicle-card-surface) 78%, transparent 22%);
		border-color: color-mix(in srgb, var(--chronicle-border) 72%, transparent 28%);
		color: var(--chronicle-text);
	}

	.sidebar-nav-link.is-active {
		background: color-mix(in srgb, var(--chronicle-accent) 9%, var(--chronicle-card-surface) 91%);
		border-color: color-mix(in srgb, var(--chronicle-accent) 25%, var(--chronicle-border) 75%);
	}

	.sidebar-nav-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 7px;
		color: inherit;
		font-size: 0.92rem;
		font-weight: 750;
		line-height: 1;
	}

	.sidebar-nav-icon svg {
		width: 18px;
		height: 18px;
	}

	.sidebar-nav-label {
		min-width: 0;
		overflow: hidden;
		font-size: 0.9rem;
		font-weight: 620;
		line-height: 1.3;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sidebar-scroll {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		overscroll-behavior: contain;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.collapsed-rail {
		display: flex;
		flex: 1;
		width: 100%;
		min-height: 0;
		flex-direction: column;
		align-items: center;
		gap: 6px;
	}

	.current-processes-anchor {
		position: relative;
	}

	.current-processes-popover {
		position: absolute;
		top: 0;
		left: calc(100% + 12px);
		width: min(360px, calc(100vw - 132px));
		max-height: min(70vh, 520px);
		padding: 16px;
		border-radius: 20px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border-strong) 82%, white 18%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 96%, white 4%);
		box-shadow: var(--chronicle-shadow);
		z-index: 4;
	}

	.popover-header {
		margin-bottom: 12px;
	}

	.popover-eyebrow,
	.popover-header h2 {
		margin: 0;
	}

	.popover-eyebrow {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--chronicle-text-muted);
	}

	.popover-header h2 {
		margin-top: 4px;
		font-size: 1rem;
		line-height: 1.35;
		color: var(--chronicle-text);
	}

	.popover-error {
		margin-bottom: 12px;
	}

	.popover-scroll {
		overflow-y: auto;
		max-height: min(52vh, 400px);
		padding-right: 2px;
	}

	.popover-process-list .process-row {
		padding-block: 12px;
	}

	.popover-section + .popover-section {
		margin-top: 16px;
		padding-top: 14px;
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 72%, transparent 28%);
	}

	.sidebar-footer {
		position: relative;
		flex: 0 0 auto;
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 72%, transparent 28%);
		z-index: 3;
	}

	.sidebar-footer.is-collapsed {
		width: 48px;
		padding-top: 8px;
	}

	.user-trigger {
		display: grid;
		grid-template-columns: 30px minmax(0, 1fr);
		align-items: center;
		gap: 9px;
		width: 100%;
		min-height: 42px;
		padding: 5px 8px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--chronicle-text-muted);
		font-weight: 620;
		text-align: left;
		cursor: pointer;
	}

	.user-trigger:hover,
	.user-trigger[aria-expanded="true"] {
		border-color: color-mix(in srgb, var(--chronicle-border) 72%, transparent 28%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 78%, transparent 22%);
		color: var(--chronicle-text);
	}

	.user-trigger.is-collapsed {
		display: grid;
		grid-template-columns: 1fr;
		place-items: center;
		width: 48px;
		height: 48px;
		padding: 0;
	}

	.footer-icon,
	.footer-icon svg {
		display: block;
		width: 20px;
		height: 20px;
	}

	.footer-icon {
		justify-self: center;
	}

	.user-name {
		min-width: 0;
		overflow: hidden;
		font-size: 0.875rem;
		line-height: 1.35;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.user-popover {
		position: absolute;
		left: 0;
		bottom: calc(100% + 8px);
		display: grid;
		gap: 4px;
		width: 100%;
		padding: 6px;
		border: 1px solid var(--chronicle-border);
		border-radius: 14px;
		background: var(--chronicle-card-surface);
		box-shadow: var(--chronicle-shadow-soft);
		z-index: 5;
	}

	.user-popover.is-collapsed {
		left: calc(100% + 12px);
		bottom: 0;
		width: 180px;
	}

	.user-popover-action {
 display: block;
 text-decoration: none;
		width: 100%;
		min-height: 38px;
		padding: 8px 10px;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: var(--chronicle-text);
		font-size: 0.875rem;
		font-weight: 620;
		text-align: left;
		cursor: pointer;
	}

	.user-popover-action:hover:not(:disabled) {
		background: var(--chronicle-panel-muted);
	}

	.user-popover-action:disabled {
		cursor: wait;
		opacity: 0.58;
	}

	.logout-error {
		margin: 4px 8px 6px;
		color: var(--chronicle-danger-text);
		font-size: var(--type-caption);
		line-height: 1.4;
	}

	.process-group {
		--process-row-gutter: var(--space-xs);
		display: flex;
		min-height: 0;
		flex: 1 1 0;
		flex-direction: column;
		gap: 10px;
		padding-inline: var(--process-row-gutter);
	}

	.process-group.is-empty {
		flex: 0 0 auto;
	}

	.process-group:not(.is-empty) {
		min-height: 124px;
	}

	.waiting-group:not(.is-empty) {
		flex-grow: 1.06;
	}

	.running-group:not(.is-empty) {
		flex-grow: 0.94;
	}

	.future-group:not(.is-empty) {
		flex-grow: 0.8;
	}

	.group-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		min-height: 20px;
	}

	.group-header.compact {
		margin-top: 2px;
		margin-bottom: 6px;
	}

	.group-heading {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--chronicle-text-muted);
	}

	.group-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 22px;
		height: 20px;
		padding: 0 7px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 80%, transparent 20%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 74%, transparent 26%);
		color: var(--chronicle-text-faint);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}

	.sidebar-scroll > .process-group > .process-list {
		min-height: 0;
		margin-inline: calc(-1 * var(--process-row-gutter));
		overflow-y: auto;
	}

	.process-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.process-row {
		display: block;
		padding: calc(var(--space-xs) + 1px) var(--process-row-gutter, var(--space-xs));
		border-radius: 14px;
		box-shadow: inset 0 0 0 1px transparent;
		color: inherit;
		text-decoration: none;
	}

	.process-row:hover {
		background: color-mix(in srgb, var(--chronicle-card-surface) 92%, var(--chronicle-accent) 8%);
		box-shadow: inset 0 0 0 1px
			color-mix(in srgb, var(--chronicle-border) 76%, var(--chronicle-accent) 24%);
	}

	.process-row.is-selected {
		background: color-mix(in srgb, var(--chronicle-card-surface) 92%, var(--chronicle-accent) 8%);
		box-shadow: inset 0 0 0 1px
			color-mix(in srgb, var(--chronicle-accent) 18%, var(--chronicle-border) 82%);
	}

	.row-copy {
		display: grid;
		gap: 1px;
		min-width: 0;
	}

	.row-status-line {
		display: block;
		min-width: 0;
	}

	.row-status-text.running,
	.row-status-text.future-action {
		color: color-mix(in srgb, var(--chronicle-accent) 76%, var(--chronicle-text) 24%);
	}

	.row-status-text.waiting,
	.row-status-text.future-once {
		color: color-mix(in srgb, var(--chronicle-attention) 76%, var(--chronicle-text) 24%);
	}

	.row-status-text.error {
		color: color-mix(in srgb, var(--chronicle-danger) 76%, var(--chronicle-text) 24%);
	}

	.row-status-text.completed,
	.row-status-text.future-cron {
		color: color-mix(in srgb, var(--chronicle-success) 70%, var(--chronicle-text) 30%);
	}

	.row-title {
		font-size: 0.95rem;
		line-height: 1.32;
		font-weight: 620;
		color: var(--chronicle-text);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.row-meta {
		font-size: 0.75rem;
		line-height: 1.32;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--chronicle-text-faint);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.row-secondary {
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--chronicle-text-muted);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}


	.group-error,
	.empty-state {
		font-size: 0.875rem;
		line-height: 1.55;
		padding: 2px 0;
	}

	.group-error {
		margin: 0;
		color: var(--chronicle-danger-text);
	}

	.empty-state {
		font-size: 0.875rem;
		line-height: 1.55;
		color: var(--chronicle-text-muted);
		padding: 2px 0;
	}

	.connection-overlay {
		position: absolute;
		left: 18px;
		right: 18px;
		bottom: 76px;
		padding: 14px;
		border-radius: 16px;
		border: 1px solid color-mix(in srgb, var(--chronicle-danger) 46%, var(--chronicle-border) 54%);
		background: color-mix(in srgb, white 92%, var(--chronicle-danger) 8%);
	}

	.overlay-title {
		margin: 0 0 4px;
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--chronicle-danger-text);
	}

	.overlay-copy {
		margin: 0;
		font-size: 0.875rem;
		line-height: 1.55;
		color: var(--chronicle-text);
	}

	@media (max-width: 960px) {
		.sidebar,
		.sidebar[data-sidebar-state="collapsed"] {
			flex: none;
			width: 100%;
			max-width: none;
			min-width: 0;
			height: 100%;
			padding: max(16px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left));
			border-right: 0;
			border-bottom: 0;
			overflow: hidden;
			align-items: stretch;
		}

		.sidebar-header {
			margin-bottom: 16px;
			padding-right: 48px;
		}

		.sidebar-scroll {
			display: flex;
			flex: 1 1 auto;
			flex-direction: column;
			gap: 16px;
			min-height: 0;
			overflow-y: auto;
			overscroll-behavior: contain;
			padding-bottom: 0;
		}

		.process-group {
			padding: 14px;
			border-radius: 18px;
			background: color-mix(in srgb, var(--chronicle-card-surface) 92%, var(--chronicle-panel-muted) 8%);
			border: 1px solid color-mix(in srgb, var(--chronicle-border) 88%, white 12%);
		}

		.process-group,
		.process-group.is-empty,
		.process-group:not(.is-empty) {
			min-height: 0;
			flex: none;
		}

		.sidebar-scroll > .process-group > .process-list {
			overflow-y: visible;
		}

		.connection-overlay {
			position: static;
			margin-top: 16px;
		}
	}
</style>

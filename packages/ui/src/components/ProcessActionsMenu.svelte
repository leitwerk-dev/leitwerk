<script lang="ts">
import { tick } from "svelte";
import {
	fetchProcessRetryConfig,
	postProcessAbort,
	deleteProcess as requestProcessDeletion,
} from "../lib/api.js";
import { keyboardShortcutHelpOpen } from "../lib/keyboard-shortcuts-help.js";
import { setPendingRetryConfig } from "../lib/retry-config.svelte.js";
import { buildHomePath, navigate } from "../lib/router.svelte.js";
import { resolveApiUrl } from "../lib/runtime-config.js";

interface Props {
	instanceId: string;
	lifecycleStatus: string | null;
	disabled?: boolean;
	hasSessionFile?: boolean;
	processLabel: string;
	onDeleted?: () => void;
}

let {
	instanceId,
	lifecycleStatus,
	disabled = false,
	hasSessionFile = false,
	processLabel,
	onDeleted,
}: Props = $props();

let menuOpen = $state(false);
let confirmation = $state<"abort" | "abort-and-retry" | "delete" | null>(null);
let busy = $state(false);
let error = $state<string | null>(null);

let menuRef = $state<HTMLDivElement | null>(null);
let triggerRef = $state<HTMLButtonElement | null>(null);
let dropdownRef = $state<HTMLDivElement | null>(null);

const isFinished = $derived(lifecycleStatus === "completed" || lifecycleStatus === "aborted");
const actionTarget = $derived(processLabel.trim() || `process ${instanceId}`);
const triggerId = $derived(`process-actions-trigger-${instanceId}`);
const menuId = $derived(`process-actions-menu-${instanceId}`);
const confirmationView = $derived({
	message:
		confirmation === "abort"
			? `Abort ${actionTarget}? This can’t be undone.`
			: confirmation === "delete"
				? `Permanently delete ${actionTarget}? ${isFinished ? "" : "Active work will be stopped first. "}History and managed stored artifacts will be permanently removed. This can’t be undone.`
				: `Abort ${actionTarget}, then prepare a new process with the same setup. Existing history will remain available.`,
	cancelLabel: confirmation === "abort" ? "Keep process running" : "Keep current process",
	buttonLabel:
		confirmation === "abort"
			? busy
				? "Aborting…"
				: "Abort process"
			: confirmation === "delete"
				? busy
					? "Deleting…"
					: "Delete process"
				: busy
					? "Working…"
					: "Abort & retry",
	action:
		confirmation === "abort"
			? handleAbort
			: confirmation === "delete"
				? handleDelete
				: handleAbortAndRetry,
});

function toggleMenu() {
	if (disabled || busy) return;
	menuOpen = !menuOpen;
	confirmation = null;
	error = null;
}

function closeMenu(options: { restoreFocus?: boolean } = {}) {
	menuOpen = false;
	confirmation = null;
	error = null;
	if (options.restoreFocus) {
		queueMicrotask(() => triggerRef?.focus());
	}
}

function handleClickOutside(event: MouseEvent) {
	if (menuRef && !menuRef.contains(event.target as Node)) {
		closeMenu();
	}
}

function handleKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented || $keyboardShortcutHelpOpen) {
		return;
	}
	if (event.key === "Escape") {
		closeMenu({ restoreFocus: true });
	}
}

function focusFirstMenuControl() {
	const firstControl = dropdownRef?.querySelector<HTMLButtonElement>("button:not([disabled])");
	firstControl?.focus();
}

function handleMenuKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.preventDefault();
		closeMenu({ restoreFocus: true });
		return;
	}
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
		return;
	}
	const controls = dropdownRef
		? [...dropdownRef.querySelectorAll<HTMLButtonElement>("button:not([disabled])")]
		: [];
	if (controls.length === 0) {
		return;
	}
	const currentIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
	const nextIndex =
		event.key === "ArrowDown"
			? currentIndex < controls.length - 1
				? currentIndex + 1
				: 0
			: currentIndex > 0
				? currentIndex - 1
				: controls.length - 1;
	event.preventDefault();
	controls[nextIndex]?.focus();
}

$effect(() => {
	if (menuOpen) {
		void tick().then(focusFirstMenuControl);
		document.addEventListener("click", handleClickOutside, true);
		document.addEventListener("keydown", handleKeydown);
		return () => {
			document.removeEventListener("click", handleClickOutside, true);
			document.removeEventListener("keydown", handleKeydown);
		};
	}
});

async function runBusy(work: () => Promise<void>, fallbackError: string) {
	busy = true;
	error = null;
	try {
		await work();
	} catch (e) {
		error = e instanceof Error ? e.message : fallbackError;
	} finally {
		busy = false;
	}
}

async function handleAbort() {
	if (confirmation !== "abort") {
		confirmation = "abort";
		return;
	}
	await runBusy(async () => {
		await postProcessAbort(instanceId);
		closeMenu();
	}, "Couldn't abort process");
}

function cancelConfirmation() {
	confirmation = null;
	error = null;
}

async function handleDelete() {
	if (confirmation !== "delete") {
		confirmation = "delete";
		return;
	}
	await runBusy(async () => {
		await requestProcessDeletion(instanceId);
		closeMenu();
		onDeleted?.();
	}, "Couldn't delete process");
}

async function handleRetry() {
	await runBusy(async () => {
		const config = await fetchProcessRetryConfig(instanceId);
		setPendingRetryConfig(config);
		navigate(buildHomePath(config.launcherId));
	}, "Couldn't load retry config");
}

async function handleAbortAndRetry() {
	if (confirmation !== "abort-and-retry") {
		confirmation = "abort-and-retry";
		return;
	}
	await runBusy(async () => {
		const config = await fetchProcessRetryConfig(instanceId);
		await postProcessAbort(instanceId);
		setPendingRetryConfig(config);
		navigate(buildHomePath(config.launcherId));
	}, "Couldn't abort and retry");
}

function handleDownloadSession() {
	const url = resolveApiUrl(`/api/processes/${encodeURIComponent(instanceId)}/session`);
	window.open(url, "_blank");
	closeMenu();
}
</script>

<div class="process-actions-menu" bind:this={menuRef}>
	<button
		bind:this={triggerRef}
		id={triggerId}
		type="button"
		class="menu-trigger"
		data-pressable="true"
		aria-haspopup="menu"
		aria-controls={menuOpen ? menuId : undefined}
		aria-expanded={menuOpen}
		disabled={disabled || busy}
		onclick={toggleMenu}
		aria-label={`Open actions for ${actionTarget}`}
		title={`Actions for ${actionTarget}`}
	>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="3"></circle>
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
		</svg>
		<span class="menu-trigger-label">More actions</span>
	</button>

	{#if menuOpen}
		<div
			id={menuId}
			class="menu-dropdown"
			role="menu"
			aria-labelledby={triggerId}
			tabindex="-1"
			bind:this={dropdownRef}
			onkeydown={handleMenuKeydown}
		>
			<p class="menu-context">Actions for {actionTarget}.</p>
			{#if error}
				<p class="menu-error" role="alert">{error}</p>
			{/if}

			{#if confirmation}
				<div class="confirm-panel">
					<p class="confirm-message">{confirmationView.message}</p>
					<div class="confirm-actions">
						<button
							type="button"
							class="confirm-cancel"
							data-pressable="true"
							disabled={busy}
							onclick={cancelConfirmation}
						>
							{confirmationView.cancelLabel}
						</button>
						<button
							type="button"
							class="confirm-danger"
							data-pressable="true"
							disabled={busy}
							onclick={confirmationView.action}
						>
							{confirmationView.buttonLabel}
						</button>
					</div>
				</div>
			{:else}
				{#if hasSessionFile}
					<button
						type="button"
						class="menu-item"
						role="menuitem"
						data-pressable="true"
						disabled={busy}
						onclick={handleDownloadSession}
					>
						Download Pi session (.jsonl)
					</button>
					<div class="menu-divider" role="separator"></div>
				{/if}
				{#if !isFinished}
					<button
						type="button"
						class="menu-item"
						role="menuitem"
						data-pressable="true"
						disabled={busy}
						onclick={handleAbort}
					>
						Abort process
					</button>
				{/if}
				<button
					type="button"
					class="menu-item"
					role="menuitem"
					data-pressable="true"
					disabled={busy}
					onclick={handleRetry}
				>
					{busy ? "Loading…" : "Retry as new process"}
				</button>
				{#if !isFinished}
					<button
						type="button"
						class="menu-item"
						role="menuitem"
						data-pressable="true"
						disabled={busy}
						onclick={handleAbortAndRetry}
					>
						Abort and retry as new process
					</button>
				{/if}
				<div class="menu-divider" role="separator"></div>
				<button
					type="button"
					class="menu-item menu-item-danger"
					role="menuitem"
					data-pressable="true"
					disabled={busy}
					onclick={handleDelete}
				>
					Delete process
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.process-actions-menu {
		position: relative;
	}

	.menu-trigger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		min-height: 38px;
		padding: 0 12px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 88%, transparent 12%);
		border-radius: 999px;
		background: color-mix(in srgb, var(--chronicle-card-surface) 76%, transparent 24%);
		color: var(--chronicle-text-muted);
		font: inherit;
		font-size: var(--type-body-sm, 13px);
		font-weight: 620;
		white-space: nowrap;
		cursor: pointer;
	}

	.menu-trigger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--chronicle-panel-muted) 60%, transparent 40%);
		color: var(--chronicle-text);
		border-color: var(--chronicle-border);
	}

	.menu-trigger:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.menu-trigger[aria-expanded="true"] {
		background: var(--chronicle-panel-muted);
		color: var(--chronicle-text);
		border-color: var(--chronicle-border-strong);
	}

	.menu-dropdown {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 100;
		min-width: 248px;
		padding: 8px;
		border: 1px solid var(--chronicle-border-strong);
		border-radius: 12px;
		background: var(--chronicle-card-surface);
		box-shadow: var(--chronicle-shadow);
	}

	.menu-context {
		margin: 0 0 6px;
		padding: 6px 8px 8px;
		border-bottom: 1px solid var(--chronicle-border);
		font-size: var(--type-caption, 12px);
		font-weight: 700;
		line-height: 1.35;
		color: var(--chronicle-text-faint);
	}

	.menu-item {
		display: block;
		width: 100%;
		padding: 10px 12px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--chronicle-text);
		font: inherit;
		font-size: var(--type-body-sm, 13px);
		font-weight: 750;
		text-align: left;
		cursor: pointer;
	}

	.menu-item:hover:not(:disabled) {
		background: var(--chronicle-panel-muted);
	}

	.menu-item-danger {
		color: var(--chronicle-danger-text);
	}

	.menu-item-danger:hover:not(:disabled) {
		background: var(--chronicle-danger-surface);
	}

	.menu-item:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.menu-divider {
		height: 1px;
		margin: 6px 0;
		background: var(--chronicle-border);
	}

	.menu-error {
		margin: 0 0 8px;
		padding: 10px 12px;
		border-radius: 10px;
		background: var(--chronicle-danger-surface);
		border: 1px solid var(--chronicle-danger-border);
		font-size: 13px;
		line-height: 1.45;
		color: var(--chronicle-danger-text);
	}

	.confirm-panel {
		padding: 12px;
	}

	.confirm-message {
		margin: 0 0 12px;
		font-size: var(--type-body-sm, 13px);
		font-weight: 650;
		line-height: 1.5;
		color: var(--chronicle-text);
	}

	.confirm-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}

	.confirm-cancel,
	.confirm-danger {
		min-height: 36px;
		padding: 0 14px;
		border-radius: 999px;
		font: inherit;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}

	.confirm-cancel {
		border: 1px solid var(--chronicle-border-strong);
		background: var(--chronicle-card-surface);
		color: var(--chronicle-text);
	}

	.confirm-cancel:hover:not(:disabled) {
		background: var(--chronicle-panel-muted);
	}

	.confirm-danger {
		border: 1px solid var(--chronicle-danger-border);
		background: var(--chronicle-danger);
		color: var(--chronicle-text-on-accent);
	}

	.confirm-danger:hover:not(:disabled) {
		opacity: 0.9;
	}

	.confirm-cancel:disabled,
	.confirm-danger:disabled {
		opacity: 0.5;
		cursor: default;
	}

	@media (max-width: 720px) {
		.process-actions-menu,
		.menu-trigger {
			width: 100%;
		}
	}
</style>

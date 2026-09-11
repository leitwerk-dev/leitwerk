<script lang="ts">
import type { SessionTransferOperationView } from "@leitwerk-dev/protocol/http-contracts";
import { tick } from "svelte";
import {
	cancelSessionTransfer,
	createSessionTransferGrant,
	fetchProcessRetryConfig,
	postProcessAbort,
	deleteProcess as requestProcessDeletion,
	type SessionTransferGrantResponse,
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
	presentation?: "default" | "sheet";
	idSuffix?: string;
	sessionTransfer?: SessionTransferOperationView | null;
}

let {
	instanceId,
	lifecycleStatus,
	disabled = false,
	hasSessionFile = false,
	processLabel,
	onDeleted,
	presentation = "default",
	idSuffix = "",
	sessionTransfer = null,
}: Props = $props();

let menuOpen = $state(false);
let confirmation = $state<"abort" | "abort-and-retry" | "delete" | null>(null);
let busy = $state(false);
let error = $state<string | null>(null);
let transferGrant = $state<SessionTransferGrantResponse | null>(null);
let copyStatus = $state<"idle" | "copied" | "failed">("idle");
let locallyCancelledAttemptId = $state<string | null>(null);

let menuRef = $state<HTMLDivElement | null>(null);
let triggerRef = $state<HTMLButtonElement | null>(null);
let dropdownRef = $state<HTMLDivElement | null>(null);
let transferLinkRef = $state<HTMLInputElement | null>(null);

const isFinished = $derived(lifecycleStatus === "completed" || lifecycleStatus === "aborted");
const actionTarget = $derived(processLabel.trim() || `process ${instanceId}`);
const activeTransfer = $derived(
	sessionTransfer?.attemptId === locallyCancelledAttemptId ? null : sessionTransfer,
);

function phaseLabel(phase: string): string {
	return (
		(
			{
				queued: "Queued",
				waiting_for_execution_chain: "Waiting for execution",
				stopping_worker: "Stopping worker",
				starting_exporter: "Starting exporter",
				scanning: "Scanning",
				ready_to_stream: "Ready to stream",
				streaming: "Streaming",
				awaiting_ack: "Awaiting local acknowledgement",
				consumed: "Consumed",
				cancelled: "Cancelled",
				failed: "Failed",
			} as Record<string, string>
		)[phase] ?? phase
	);
}

function transferExpiryLabel(expiresAt: string): string {
	const timestamp = Date.parse(expiresAt);
	if (!Number.isFinite(timestamp)) return "Expiry unavailable";
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(timestamp);
}

const idDisambiguator = $derived(idSuffix ? `-${idSuffix}` : "");
const triggerId = $derived(`process-actions-trigger-${instanceId}${idDisambiguator}`);
const menuId = $derived(`process-actions-menu-${instanceId}${idDisambiguator}`);
const confirmationView = $derived({
	message:
		confirmation === "abort"
			? `Abort ${actionTarget}? Active work will stop. Its history will remain available. This can’t be undone.`
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
					? "Preparing new process…"
					: "Abort and retry",
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
	copyStatus = "idle";
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

$effect(() => {
	if (menuOpen && (confirmation || transferGrant)) void tick().then(focusFirstMenuControl);
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

async function handleCreateTransfer() {
	copyStatus = "idle";
	await runBusy(async () => {
		transferGrant = await createSessionTransferGrant(instanceId);
		await tick();
		transferLinkRef?.focus();
	}, "Couldn't create local transfer link");
}

async function handleCopyTransferLink() {
	if (!transferGrant) return;
	try {
		await navigator.clipboard.writeText(transferGrant.transferUrl);
		copyStatus = "copied";
	} catch {
		copyStatus = "failed";
	}
}

async function handleCancelTransfer() {
	if (!activeTransfer) return;
	await runBusy(async () => {
		await cancelSessionTransfer(instanceId, activeTransfer.attemptId);
		locallyCancelledAttemptId = activeTransfer.attemptId;
	}, "Couldn't cancel the local session transfer");
}

function showActions() {
	transferGrant = null;
	copyStatus = "idle";
	error = null;
	void tick().then(focusFirstMenuControl);
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

{#snippet menuItem(
	key: string,
	label: string,
	action: () => void,
	danger = false,
)}
	<button
		type="button"
		class="menu-item"
		class:menu-item-danger={danger}
		role="menuitem"
		data-menu-item={key}
		data-pressable="true"
		disabled={busy}
		onclick={action}
	>
		{label}
	</button>
{/snippet}

<div class="process-actions-menu" data-presentation={presentation} bind:this={menuRef}>
	<button
		bind:this={triggerRef}
		id={triggerId}
		type="button"
		class="ui-button menu-trigger"
		data-pressable="true"
		aria-haspopup="menu"
		aria-controls={menuOpen ? menuId : undefined}
		aria-expanded={menuOpen}
		disabled={disabled || busy}
		onclick={toggleMenu}
		aria-label={`Open actions for ${actionTarget}`}
		title={`Actions for ${actionTarget}`}
	>
		<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
		</svg>
		<span class:sr-only={presentation === "sheet"} class="menu-trigger-label">More actions</span>
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
			{#if activeTransfer}
				<p class="menu-note" role="status">
					<strong>Local transfer: {phaseLabel(activeTransfer.phase)}.</strong>
					{activeTransfer.blocksManualTurns ? " New manual turns are blocked until streaming ends." : " The process is unblocked; streamed bytes can no longer be recalled."}
				</p>
				{#if activeTransfer.blocksManualTurns}
					{@render menuItem("cancel-transfer", busy ? "Cancelling…" : "Cancel transfer", handleCancelTransfer)}
				{/if}
				<div class="menu-divider" role="separator"></div>
			{/if}

			{#if transferGrant}
				<div class="confirm-panel transfer-panel" aria-label="Local Pi transfer link">
					<p class="confirm-message">Open this process in local Pi</p>
					<p class="transfer-note">Single use · expires {transferExpiryLabel(transferGrant.expiresAt)}</p>
					<label class="transfer-field-label" for={`transfer-link-${instanceId}${idDisambiguator}`}>Transfer link</label>
					<input
						bind:this={transferLinkRef}
						id={`transfer-link-${instanceId}${idDisambiguator}`}
						class="transfer-link"
						readonly
						value={transferGrant.transferUrl}
						onfocus={(event) => event.currentTarget.select()}
					/>
					<p class="transfer-note">Anyone with this link can download this session and workspace.</p>
					<div class="confirm-actions">
						<button type="button" class="ui-button confirm-cancel" data-pressable="true" onclick={showActions}>Back</button>
						<button type="button" class="ui-button confirm-cancel" data-pressable="true" onclick={handleCopyTransferLink}>
							{copyStatus === "copied" ? "Copied" : "Copy link"}
						</button>
					</div>
					<p class="transfer-note" aria-live="polite">
						{copyStatus === "copied" ? "Transfer link copied." : copyStatus === "failed" ? "Copy failed. Select and copy the link manually." : ""}
					</p>
				</div>
			{:else if confirmation}
				<div class="confirm-panel">
					<p class="confirm-message">{confirmationView.message}</p>
					<div class="confirm-actions">
						<button
							type="button"
							class="ui-button confirm-cancel"
							data-pressable="true"
							disabled={busy}
							onclick={cancelConfirmation}
						>
							{confirmationView.cancelLabel}
						</button>
						<button
							type="button"
							class="ui-button confirm-danger" data-variant="danger"
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
					{@render menuItem("create-transfer", busy ? "Creating transfer link…" : "Create local transfer link", handleCreateTransfer)}
					{@render menuItem("download-session", "Download Pi session (.jsonl)", handleDownloadSession)}
					<div class="menu-divider" role="separator"></div>
				{/if}
				{#if !isFinished}
					{@render menuItem("abort", "Abort process", handleAbort)}
				{/if}
				{@render menuItem("retry", busy ? "Loading…" : "Retry as new process", handleRetry)}
				{#if !isFinished}
					{@render menuItem("abort-and-retry", "Abort and retry as new process", handleAbortAndRetry)}
				{/if}
				<div class="menu-divider" role="separator"></div>
				{@render menuItem("delete", "Delete process", handleDelete, true)}
			{/if}
		</div>
	{/if}
</div>

<style>
	.process-actions-menu {
		position: relative;
	}

	.process-actions-menu[data-presentation="sheet"] .menu-trigger {
		width: 44px;
		min-height: 44px;
		padding: 0;
		border-radius: 10px;
	}

	.process-actions-menu[data-presentation="sheet"] .menu-trigger svg {
		display: none;
	}

	.process-actions-menu[data-presentation="sheet"] .menu-trigger::before {
		content: "";
		width: 3px;
		height: 3px;
		border-radius: 999px;
		background: currentColor;
		box-shadow: -6px 0 currentColor, 6px 0 currentColor;
	}

	.menu-dropdown {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 100;
		width: min(360px, calc(100vw - 32px));
		max-height: min(640px, calc(100dvh - 140px));
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 8px;
		border: 1px solid var(--chronicle-border-strong);
		border-radius: 14px;
		background: var(--chronicle-card-surface);
		box-shadow: var(--chronicle-shadow);
	}

	.process-actions-menu[data-presentation="sheet"] .menu-dropdown {
		top: auto;
		bottom: calc(100% + 8px);
		right: 0;
		max-width: min(320px, calc(100vw - 32px));
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
		border-radius: 10px;
		background: transparent;
		color: var(--chronicle-text);
		font: inherit;
		font-size: var(--type-body-sm, 13px);
		font-weight: 620;
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

	.menu-note {
		margin: 0;
		padding: 6px 8px;
		font-size: var(--type-caption, 12px);
		line-height: 1.45;
		color: var(--chronicle-text-muted);
	}

	.menu-note strong {
		color: var(--chronicle-text);
	}

	.transfer-panel {
		min-width: 0;
	}

	.transfer-note {
		min-height: 18px;
		margin: 8px 0;
		font-size: var(--type-caption, 12px);
		line-height: 1.45;
		color: var(--chronicle-text-muted);
	}

	.transfer-field-label {
		display: block;
		margin: 12px 0 6px;
		font-size: var(--type-caption, 12px);
		font-weight: 700;
		color: var(--chronicle-text-muted);
	}

	.transfer-link {
		box-sizing: border-box;
		width: 100%;
		min-height: 42px;
		padding: 10px 12px;
		border: 1px solid var(--chronicle-border-strong);
		border-radius: 10px;
		background: var(--chronicle-panel-muted);
		color: var(--chronicle-text);
		font: 500 var(--type-caption, 12px) / 1.4 var(--font-mono, ui-monospace, monospace);
	}

	.transfer-link:focus-visible {
		outline: 2px solid var(--chronicle-accent);
		outline-offset: 2px;
	}

	.transfer-panel .confirm-actions {
		margin-top: 12px;
	}

	.menu-error {
		margin: 0 0 8px;
		padding: 10px 12px;
		border-radius: 10px;
		background: var(--chronicle-danger-surface);
		border: 1px solid var(--chronicle-danger-border);
		font-size: var(--type-body-sm, 13px);
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
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	@media (max-width: 720px) {
		.process-actions-menu:not([data-presentation="sheet"]),
		.process-actions-menu:not([data-presentation="sheet"]) .menu-trigger {
			width: 100%;
		}
	}
</style>

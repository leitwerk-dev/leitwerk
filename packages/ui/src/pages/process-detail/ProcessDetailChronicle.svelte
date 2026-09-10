<script lang="ts">
import type { ProcessExternalTriggerSignal } from "@leitwerk-dev/protocol";
import { tick } from "svelte";
import ChronicleFlow from "../../chronicle/components/ChronicleFlow.svelte";
import ChronicleTerminalSummary from "../../chronicle/components/ChronicleTerminalSummary.svelte";
import ChronicleTurnRail from "../../chronicle/components/ChronicleTurnRail.svelte";
import CompactActionComposer from "../../chronicle/components/CompactActionComposer.svelte";
import type {
	ChronicleProjection,
	ChronicleReasoningDetailEntry,
} from "../../chronicle/lib/chronicle-projection.js";
import {
	CHRONICLE_ACTION_SECTION_ANCHOR_ID,
	type ChronicleSelectableItem,
	moveChronicleAnchorByOffset,
	resolveChronicleTurnRecordIdForAnchor,
} from "../../chronicle/lib/chronicle-selectable-items.js";
import type {
	ChronicleTicketArtifact,
	ChronicleTicketDraftArtifact,
} from "../../chronicle/lib/chronicle-ticket-artifact.js";
import { readTicketResultSelection } from "../../chronicle/ticket-selection.js";
import ModalShell from "../../components/ModalShell.svelte";
import ProcessActionsMenu from "../../components/ProcessActionsMenu.svelte";
import type {
	ProcessDetailData,
	ProcessExternalTriggerSummary,
	ProcessSelectedTurnSummary,
	ScheduledActionDetail,
} from "../../lib/api.js";
import { shouldIgnorePlainShortcut } from "../../lib/keyboard.js";
import type { ProcessTerminalStatus } from "../../lib/process-terminal-display.js";
import type { createProcessDetailActions } from "./process-detail-actions.svelte.js";
import { fitChronicleToViewport } from "./process-detail-chronicle-dom.js";
import { createProcessDetailChronicleScroll } from "./process-detail-chronicle-scroll.svelte.js";
import type {
	CurrentProcessErrorViewModel,
	CurrentTurnRecoveryViewModel,
} from "./process-detail-view-model.js";
import TicketCreationComposer from "./TicketCreationComposer.svelte";

interface Props {
	instanceId: string;
	detail: ProcessDetailData | null;
	loading: boolean;
	error: string | null;
	projection: ChronicleProjection;
	railItems: readonly ChronicleSelectableItem[];
	headingId: string;
	terminalSummaryStatus: ProcessTerminalStatus | null;
	definesLeafOutcome: boolean;
	actionsController: ReturnType<typeof createProcessDetailActions>;
	externalTriggers: readonly ProcessExternalTriggerSummary[];
	externalTriggerSignals: readonly ProcessExternalTriggerSignal[];
	selectedTurn?: ProcessSelectedTurnSummary | null;
	recovery: CurrentTurnRecoveryViewModel | null;
	startup: ProcessDetailData["startup"];
	startupRecovery: ProcessDetailData["startupRecovery"];
	processError: CurrentProcessErrorViewModel | null;
	scheduledActionDetail: ScheduledActionDetail | null;
	reasoningDetailEntries: readonly ChronicleReasoningDetailEntry[];
	hasBlockingDetailOverlay: boolean;
	launchWarning?: string | null;
	persistedModelSelectionWarning?: string | null;
	jumpToLatestLabel: string;
	onDismissLaunchWarning: () => void;
	onOpenReasoningDetails: (turnRecordId: string) => void;
	onCloseBlockingDetailOverlays: () => void;
	isProcessInfoOpen: boolean;
	onToggleProcessInfo: () => void;
	onDeleted: () => void;
}

let {
	instanceId,
	detail,
	loading,
	error,
	projection,
	railItems,
	headingId,
	terminalSummaryStatus,
	definesLeafOutcome,
	actionsController,
	externalTriggers,
	externalTriggerSignals,
	selectedTurn = null,
	recovery,
	startup,
	startupRecovery,
	processError,
	scheduledActionDetail,
	reasoningDetailEntries,
	hasBlockingDetailOverlay,
	launchWarning = null,
	persistedModelSelectionWarning = null,
	jumpToLatestLabel,
	onDismissLaunchWarning,
	onOpenReasoningDetails,
	onCloseBlockingDetailOverlays,
	isProcessInfoOpen,
	onToggleProcessInfo,
	onDeleted,
}: Props = $props();

let chronicleViewport: HTMLDivElement | null = $state(null);
let mobileQuickNavOpen = $state(false);
let ticketDraft = $state<ChronicleTicketDraftArtifact | null>(null);
let ticketSelectionDraft = $state<ChronicleTicketDraftArtifact | null>(null);

function openTicketComposer(artifact: ChronicleTicketArtifact) {
	ticketDraft = { ...artifact };
}

function handleTicketSelection() {
	const selected = readTicketResultSelection(window.getSelection());
	if (!selected) return;
	const [kind, id] = selected.artifactId.split(":", 2);
	if (kind === "turn_result" && id)
		ticketSelectionDraft = { kind, turnRecordId: id, excerpt: selected.text };
	if (kind === "leaf_outcome" && id)
		ticketSelectionDraft = { kind, leafEntryId: id, excerpt: selected.text };
}

const processLabel = $derived(
	detail?.process.title ??
		detail?.process.externalId ??
		detail?.process.id ??
		`Process ${instanceId}`,
);

const chronicleScroll = createProcessDetailChronicleScroll({
	get instanceId() {
		return instanceId;
	},
	get detail() {
		return detail;
	},
	get projection() {
		return projection;
	},
	get railItems() {
		return railItems;
	},
	get viewport() {
		return chronicleViewport;
	},
	get openActionFormId() {
		return actionsController.openActionFormId;
	},
	onCloseBlockingDetailOverlays: () => onCloseBlockingDetailOverlays(),
});

const activeQuickNavItem = $derived(
	railItems.find((item) => item.anchorId === chronicleScroll.activeAnchorId) ??
		railItems.at(-1) ??
		null,
);

const showCompactActionComposer = $derived(
	chronicleScroll.showJumpToLatest &&
		actionsController.actionSectionActions.length > 0 &&
		!detail?.questionRequests.some((request) => request.status === "open"),
);

function openFocusedReasoningDetails() {
	const activeTurnRecordId = resolveChronicleTurnRecordIdForAnchor(
		railItems,
		chronicleScroll.activeAnchorId,
	);
	const preferredTurnRecordId =
		(activeTurnRecordId &&
		reasoningDetailEntries.some((entry) => entry.turnRecordId === activeTurnRecordId)
			? activeTurnRecordId
			: null) ??
		reasoningDetailEntries.at(-1)?.turnRecordId ??
		null;
	if (preferredTurnRecordId) {
		onOpenReasoningDetails(preferredTurnRecordId);
	}
}

function moveActiveAnchorByOffset(offset: number) {
	const nextAnchorId = moveChronicleAnchorByOffset(
		railItems,
		chronicleScroll.activeAnchorId,
		offset,
	);
	if (nextAnchorId) {
		chronicleScroll.jumpToAnchor(nextAnchorId);
	}
}

function openMobileQuickNav() {
	mobileQuickNavOpen = true;
}

function closeMobileQuickNav() {
	mobileQuickNavOpen = false;
}

function selectMobileQuickNavAnchor(anchorId: string) {
	chronicleScroll.jumpToAnchor(anchorId);
	closeMobileQuickNav();
}

function openProcessInfoFromQuickNav() {
	closeMobileQuickNav();
	onToggleProcessInfo();
}

function openDetailedActionForm(actionId: string) {
	if (actionsController.openActionFormId !== actionId) {
		actionsController.expandActionForm(actionId);
	}
	void tick().then(() => chronicleScroll.jumpToAnchor(CHRONICLE_ACTION_SECTION_ANCHOR_ID));
}

function handleWindowKeydown(event: KeyboardEvent) {
	if (mobileQuickNavOpen) return;
	if (shouldIgnorePlainShortcut(event) || !detail || hasBlockingDetailOverlay) {
		return;
	}
	if (event.key === "r" && reasoningDetailEntries.length > 0) {
		event.preventDefault();
		openFocusedReasoningDetails();
		return;
	}
	if (event.key === ".") {
		event.preventDefault();
		chronicleScroll.jumpToLatest();
		return;
	}
	if (event.key === "ArrowDown" && railItems.length > 0) {
		event.preventDefault();
		moveActiveAnchorByOffset(1);
		return;
	}
	if (event.key === "ArrowUp" && railItems.length > 0) {
		event.preventDefault();
		moveActiveAnchorByOffset(-1);
	}
}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<button
	type="button"
	class="mobile-quick-nav-trigger"
	data-action="open-mobile-quick-nav"
	data-pressable="true"
	aria-haspopup="dialog"
	aria-controls="mobile-process-quick-nav"
	aria-expanded={mobileQuickNavOpen}
	disabled={!detail || railItems.length === 0}
	onclick={openMobileQuickNav}
>
	<span class="mobile-quick-nav-label">
		<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
			<path d="M5 5h14M5 12h14M5 19h14"></path>
			<circle cx="8" cy="5" r="2" fill="var(--chronicle-card-surface)"></circle>
			<circle cx="15" cy="12" r="2" fill="var(--chronicle-card-surface)"></circle>
			<circle cx="10" cy="19" r="2" fill="var(--chronicle-card-surface)"></circle>
		</svg>
		Quick nav
	</span>
	<span class="mobile-quick-nav-current">{activeQuickNavItem?.title ?? "No steps yet"}</span>
	<svg class="mobile-quick-nav-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="m6 9 6 6 6-6"></path>
	</svg>
</button>

<div class="experience-grid">
	<div class="desktop-turn-rail">
		<ChronicleTurnRail
			{detail}
			{loading}
			{error}
			railItems={railItems}
			activeAnchorId={chronicleScroll.activeAnchorId}
			onSelectAnchor={chronicleScroll.jumpToAnchor}
		/>
	</div>

	<section
		class="chronicle"
		use:fitChronicleToViewport
		data-column="chronicle"
		aria-labelledby={headingId}
	>
		<h2 id={headingId} class="sr-only">Process timeline</h2>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- selection preserves native copy behavior -->
		<div
			class="chronicle-scroll"
			bind:this={chronicleViewport}
			data-role="chronicle-scroll"
			role="region"
			aria-label="Process results"
			data-layout-observer-ready={chronicleScroll.isLayoutObserverReady ? "true" : undefined}
			onscroll={chronicleScroll.handleScroll}
			onmouseup={handleTicketSelection}
		>
			{#if launchWarning}
				<div class="warning-banner" role="status">
					<div>
						<p class="warning-title">Started with a warning</p>
						<p class="warning-copy">{launchWarning}</p>
					</div>
					<button
						type="button"
						class="dismiss-button"
						data-pressable="true"
						onclick={onDismissLaunchWarning}
					>
						Hide
					</button>
				</div>
			{/if}
			{#if persistedModelSelectionWarning}
				<div class="warning-banner" role="status" data-section="persisted-model-selection-warning">
					<div>
						<p class="warning-title">Startup adjusted invalid model settings</p>
						<p class="warning-copy">{persistedModelSelectionWarning}</p>
					</div>
				</div>
			{/if}

			{#if loading && !detail}
				<div class="chronicle-state">Loading this process timeline…</div>
			{:else if error && !detail}
				<div class="chronicle-state chronicle-error">{error}</div>
			{:else if detail}
				{#if error}
					<div class="refresh-banner">{error} — showing the last process state we loaded.</div>
				{/if}

				{#if projection.timelineItems.length === 0 && startup.attempts.length === 0 && !startupRecovery}
					<div class="empty-state" data-section="chronicle-empty-state">
						<p>
							This process has not recorded activity yet. As the worker plans, acts, and saves results, the timeline will fill in here.
						</p>
					</div>
				{:else}
					<ChronicleFlow
						{instanceId}
						{projection}
						questionRequests={detail.questionRequests}
						toolApprovalRequests={detail.toolApprovalRequests}
						activeAnchorId={chronicleScroll.activeAnchorId}
						{definesLeafOutcome}
						hasTerminalSummary={terminalSummaryStatus !== null}
						actionSectionController={actionsController}
						scheduledActionController={actionsController}
						recoveryController={actionsController}
						liveTailController={actionsController}
						{externalTriggers}
						externalTriggerSignals={externalTriggerSignals}
						selectedTurn={selectedTurn}
						{recovery}
						{startup}
						{startupRecovery}
						{processError}
						scheduledAction={scheduledActionDetail && actionsController.editingScheduledActionId !== scheduledActionDetail.id
							? scheduledActionDetail
							: null}
						modelConfiguration={detail.modelConfiguration}
						onOpenReasoningDetails={onOpenReasoningDetails}
						onDraftTicket={openTicketComposer}
					/>
				{/if}

				{#if terminalSummaryStatus}
					<ChronicleTerminalSummary
						status={terminalSummaryStatus}
						updatedAt={detail.process.updatedAt}
						anchorId={projection.terminalRailItem?.anchorId ?? null}
						isFocused={chronicleScroll.activeAnchorId === projection.terminalRailItem?.anchorId}
					/>
				{/if}
			{/if}
		</div>

		{#if showCompactActionComposer}
			<CompactActionComposer
				actionSectionController={actionsController}
				onOpenDetails={openDetailedActionForm}
				decisionTitle={selectedTurn?.description}
				onViewContext={chronicleScroll.jumpToLatest}
			/>
		{:else if chronicleScroll.showJumpToLatest}
			<button
				type="button"
				class="return-to-current-button"
				data-pressable="true"
				onclick={chronicleScroll.jumpToLatest}
			>
				{jumpToLatestLabel}
			</button>
		{/if}
	</section>
</div>

{#if ticketSelectionDraft}
	<button
		type="button"
		class="ticket-selection-action"
		data-pressable="true"
		onclick={() => {
			if (ticketSelectionDraft) openTicketComposer(ticketSelectionDraft);
			ticketSelectionDraft = null;
		}}
	>Create issue</button>
{/if}

<TicketCreationComposer
	{instanceId}
	draft={ticketDraft}
	onClose={() => (ticketDraft = null)}
/>

<ModalShell
	open={mobileQuickNavOpen}
	titleId="mobile-process-quick-nav-title"
	closeLabel="Close quick navigation"
	onClose={closeMobileQuickNav}
	dataSection="mobile-process-quick-nav"
	panelId="mobile-process-quick-nav"
	presentation="bottom-sheet"
	width="min(100%, 560px)"
	height="min(82svh, 720px)"
	maxHeight="calc(100svh - max(48px, env(safe-area-inset-top)))"
	initialFocusSelector="[aria-current='step']"
	restoreFocusSelector="[data-action='open-mobile-quick-nav']"
>
	<div class="mobile-quick-nav-handle" aria-hidden="true"></div>
	<header class="mobile-quick-nav-header">
		<div>
			<h2 id="mobile-process-quick-nav-title">Process steps</h2>
			<p>{activeQuickNavItem?.title ?? "Choose a step"}</p>
		</div>
	</header>

	<div class="mobile-quick-nav-rail">
		<ChronicleTurnRail
			{detail}
			{loading}
			{error}
			railItems={railItems}
			activeAnchorId={chronicleScroll.activeAnchorId}
			onSelectAnchor={selectMobileQuickNavAnchor}
			headingId="mobile-process-navigation-heading"
		/>
	</div>

	<footer class="mobile-quick-nav-utilities">
		<button
			type="button"
			class="mobile-process-info-button"
			data-pressable="true"
			onclick={openProcessInfoFromQuickNav}
			aria-expanded={isProcessInfoOpen}
			aria-controls="process-info-overlay"
		>
			<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
				<circle cx="12" cy="12" r="9"></circle>
				<path d="M12 11v6M12 7.5h.01"></path>
			</svg>
			Process info
		</button>
		<ProcessActionsMenu
			{instanceId}
			lifecycleStatus={detail?.process.lifecycleStatus ?? null}
			disabled={!detail}
			hasSessionFile={detail?.session.signature !== null}
			sessionTransfer={detail?.sessionTransfer ?? null}
			{processLabel}
			{onDeleted}
			presentation="sheet"
			idSuffix="mobile"
		/>
	</footer>
</ModalShell>

<style>
	.ticket-selection-action {
		min-height: 44px;
		padding: 0 var(--space-md);
		border-radius: 999px;
		font: inherit;
		font-size: var(--type-body-sm);
		font-weight: 700;
		cursor: pointer;
		position: fixed;
		z-index: 42;
		right: var(--space-md);
		bottom: var(--space-md);
		border: 1px solid color-mix(in srgb, var(--chronicle-accent) 30%, var(--chronicle-border) 70%);
		background: var(--chronicle-text);
		color: var(--chronicle-card-surface);
		box-shadow: 0 10px 24px rgba(24, 33, 43, 0.12);
	}

	.ticket-selection-action:hover:not(:disabled) {
		transform: translateY(-1px);
	}

	.ticket-selection-action:focus-visible {
		outline: 2px solid var(--chronicle-accent);
		outline-offset: 2px;
	}

	.mobile-quick-nav-trigger {
		display: none;
	}

	.experience-grid {
		display: grid;
		grid-template-columns: minmax(196px, 220px) minmax(0, 1fr);
		gap: var(--space-md);
		width: 100%;
		flex: 1 1 auto;
		min-height: 0;
	}

	.desktop-turn-rail {
		display: flex;
		min-width: 0;
		min-height: 0;
	}

	.chronicle {
		--z-sticky-control: 30;

		position: relative;
		display: flex;
		flex-direction: column;
		width: 100%;
		max-width: 920px;
		min-height: 0;
		overflow: hidden;
	}

	.chronicle-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		overflow-anchor: none;
		scrollbar-gutter: stable;
		padding: var(--space-xs) 0 var(--space-2xl);
	}

	.warning-banner {
		display: flex;
		justify-content: space-between;
		gap: var(--space-lg);
		align-items: start;
		margin-bottom: var(--space-lg);
		padding: var(--space-md) var(--space-lg);
		border: 1px solid color-mix(in srgb, var(--chronicle-danger) 30%, var(--chronicle-border) 70%);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, white 90%, var(--chronicle-danger) 10%);
		font-size: var(--type-body);
		line-height: 1.55;
	}

	.warning-title {
		margin: 0 0 6px;
		font-size: var(--type-caption);
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--chronicle-danger-text);
	}

	.warning-copy {
		margin: 0;
		color: var(--chronicle-danger-text-strong);
	}

	.dismiss-button {
		min-height: 44px;
		padding: 0 14px;
		border: 1px solid color-mix(in srgb, var(--chronicle-danger) 24%, var(--chronicle-border) 76%);
		border-radius: 999px;
		background: color-mix(in srgb, white 92%, var(--chronicle-card-surface) 8%);
		color: var(--chronicle-danger-text);
		font-size: var(--type-body-sm);
		font-weight: 620;
		cursor: pointer;
	}

	.dismiss-button:hover,
	.return-to-current-button:hover {
		transform: translateY(-1px);
	}

	.refresh-banner,
	.empty-state,
	.chronicle-state {
		padding: var(--space-md) var(--space-lg);
		border-radius: var(--radius-lg);
		font-size: var(--type-body);
		line-height: 1.55;
		border: 1px solid var(--chronicle-border);
		background: var(--chronicle-panel-muted);
		color: var(--chronicle-text-muted);
	}

	.refresh-banner {
		margin-bottom: var(--space-lg);
	}

	.chronicle-error {
		border-color: color-mix(in srgb, var(--chronicle-danger) 30%, var(--chronicle-border) 70%);
		color: var(--chronicle-danger-text);
		background: color-mix(in srgb, white 90%, var(--chronicle-danger) 10%);
	}

	.empty-state p {
		margin: 0;
		max-width: 60ch;
	}

	.return-to-current-button {
		position: absolute;
		left: 0;
		right: 0;
		bottom: var(--space-md);
		margin-inline: auto;
		width: fit-content;
		min-height: 44px;
		padding: var(--space-xs) var(--space-md);
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--chronicle-accent) 30%, var(--chronicle-border) 70%);
		background: var(--chronicle-panel-surface);
		color: var(--chronicle-text);
		font: inherit;
		font-size: var(--type-body-sm);
		font-weight: 620;
		cursor: pointer;
		box-shadow: 0 10px 24px rgba(24, 33, 43, 0.08);
	}

	@media (max-width: 1024px) {
		.experience-grid {
			grid-template-columns: 1fr;
			height: auto;
		}

		.chronicle {
			max-width: none;
			min-height: 0;
		}

		.chronicle-scroll {
			min-height: 0;
			max-height: min(72svh, 48rem);
		}

		.ticket-selection-action {
			left: var(--space-sm);
			right: var(--space-sm);
			bottom: max(var(--space-sm), env(safe-area-inset-bottom));
			width: calc(100% - (2 * var(--space-sm)));
		}

		.mobile-quick-nav-trigger {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr) auto;
			align-items: center;
			gap: var(--space-xs);
			width: 100%;
			min-height: 42px;
			padding: 0 var(--space-sm);
			border: 1px solid color-mix(in srgb, var(--chronicle-accent) 22%, var(--chronicle-border) 78%);
			border-radius: var(--radius-md);
			background: color-mix(in srgb, var(--chronicle-card-surface) 92%, var(--chronicle-accent) 8%);
			color: var(--chronicle-text);
			font: inherit;
			cursor: pointer;
		}

		.mobile-quick-nav-trigger:hover:not(:disabled) {
			border-color: color-mix(in srgb, var(--chronicle-accent) 45%, var(--chronicle-border) 55%);
			background: color-mix(in srgb, var(--chronicle-card-surface) 86%, var(--chronicle-accent) 14%);
		}

		.mobile-quick-nav-trigger:focus-visible {
			outline: 2px solid var(--chronicle-accent);
			outline-offset: 2px;
		}

		.mobile-quick-nav-trigger:disabled {
			opacity: 0.56;
			cursor: default;
		}

		.mobile-quick-nav-label {
			display: inline-flex;
			align-items: center;
			gap: 7px;
			font-size: var(--type-body-sm);
			font-weight: 720;
			white-space: nowrap;
		}

		.mobile-quick-nav-current {
			overflow: hidden;
			color: var(--chronicle-text-muted);
			font-size: var(--type-caption);
			font-weight: 560;
			text-align: right;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.mobile-quick-nav-chevron {
			color: var(--chronicle-text-faint);
		}

		.desktop-turn-rail {
			display: none;
		}

		.mobile-quick-nav-handle {
			width: 38px;
			height: 4px;
			margin: 0 auto 8px;
			border-radius: 999px;
			background: var(--chronicle-border-strong);
		}

		.mobile-quick-nav-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: var(--space-md);
			padding: 4px 44px 12px 2px;
			border-bottom: 1px solid var(--chronicle-border);
		}

		.mobile-quick-nav-header h2,
		.mobile-quick-nav-header p {
			margin: 0;
		}

		.mobile-quick-nav-header h2 {
			font-size: var(--type-title-sm);
			line-height: 1.2;
			color: var(--chronicle-text);
		}

		.mobile-quick-nav-header p {
			margin-top: 3px;
			max-width: 32ch;
			overflow: hidden;
			color: var(--chronicle-text-muted);
			font-size: var(--type-caption);
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.mobile-process-info-button:focus-visible {
			outline: 2px solid var(--chronicle-accent);
			outline-offset: 2px;
		}

		.mobile-quick-nav-rail {
			flex: 1 1 auto;
			min-height: 0;
			overflow: hidden;
			padding: 10px 0 8px;
		}

		.mobile-quick-nav-rail :global(.turn-rail) {
			height: 100%;
			padding-right: 0;
			border-right: 0;
		}

		.mobile-quick-nav-rail :global(.rail-list) {
			overflow-x: hidden;
			overflow-y: auto;
			scroll-snap-type: none;
			scrollbar-gutter: auto;
			padding: var(--space-2xs) var(--space-2xs) var(--space-xs) 0;
		}

		.mobile-quick-nav-rail :global(.rail-track) {
			flex-direction: column;
			gap: var(--space-2xs);
			width: 100%;
			min-width: 0;
		}

		.mobile-quick-nav-rail :global(.rail-track::before) {
			display: block;
		}

		.mobile-quick-nav-rail :global(.rail-item) {
			min-width: 0;
			scroll-snap-align: none;
			padding: var(--space-xs);
		}

		.mobile-quick-nav-utilities {
			display: flex;
			align-items: center;
			gap: var(--space-xs);
			padding-top: 10px;
			border-top: 1px solid var(--chronicle-border);
		}

		.mobile-process-info-button {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 7px;
			flex: 1 1 auto;
			min-height: 40px;
			padding: 0 var(--space-sm);
			border: 1px solid var(--chronicle-border);
			border-radius: 10px;
			background: var(--chronicle-card-surface);
			color: var(--chronicle-text);
			font: inherit;
			font-size: var(--type-body-sm);
			font-weight: 650;
			cursor: pointer;
		}

		.mobile-process-info-button:hover {
			background: var(--chronicle-panel-muted);
		}

		.warning-banner {
			flex-direction: column;
		}

		.dismiss-button {
			width: 100%;
		}

		.return-to-current-button {
			position: fixed;
			left: var(--space-sm);
			right: var(--space-sm);
			bottom: var(--space-sm);
			z-index: var(--z-sticky-control);
			max-width: calc(100% - (2 * var(--space-sm)));
		}
	}

</style>

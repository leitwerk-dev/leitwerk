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
	ProcessDetailData,
	ProcessExternalTriggerSummary,
	ProcessSelectedTurnSummary,
	ScheduledActionDetail,
} from "../../lib/api.js";
import { shouldIgnorePlainShortcut } from "../../lib/keyboard.js";
import type { ProcessTerminalStatus } from "../../lib/process-terminal-display.js";
import type { createProcessDetailActions } from "./process-detail-actions.svelte.js";
import { createProcessDetailChronicleScroll } from "./process-detail-chronicle-scroll.svelte.js";
import type {
	CurrentProcessErrorViewModel,
	CurrentTurnRecoveryViewModel,
} from "./process-detail-view-model.js";

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
}: Props = $props();

let chronicleViewport: HTMLDivElement | null = $state(null);

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

function openDetailedActionForm(actionId: string) {
	if (actionsController.openActionFormId !== actionId) {
		actionsController.expandActionForm(actionId);
	}
	void tick().then(() => chronicleScroll.jumpToAnchor(CHRONICLE_ACTION_SECTION_ANCHOR_ID));
}

function handleWindowKeydown(event: KeyboardEvent) {
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

<div class="experience-grid">
	<ChronicleTurnRail
		{detail}
		{loading}
		{error}
		railItems={railItems}
		activeAnchorId={chronicleScroll.activeAnchorId}
		onSelectAnchor={chronicleScroll.jumpToAnchor}
	/>

	<section
		class="chronicle"
		data-column="chronicle"
		aria-labelledby={headingId}
	>
		<h2 id={headingId} class="sr-only">Process timeline</h2>
		<div
			class="chronicle-scroll"
			bind:this={chronicleViewport}
			data-role="chronicle-scroll"
			data-layout-observer-ready={chronicleScroll.isLayoutObserverReady ? "true" : undefined}
			onscroll={chronicleScroll.handleScroll}
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

				{#if projection.timelineItems.length === 0 && !startupRecovery}
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
						{startupRecovery}
						{processError}
						scheduledAction={scheduledActionDetail && actionsController.editingScheduledActionId !== scheduledActionDetail.id
							? scheduledActionDetail
							: null}
						modelConfiguration={detail.modelConfiguration}
						onOpenReasoningDetails={onOpenReasoningDetails}
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

<style>
	.experience-grid {
		display: grid;
		grid-template-columns: minmax(196px, 220px) minmax(0, 1fr);
		gap: var(--space-md);
		width: 100%;
		flex: 1 1 auto;
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
		font-size: 12px;
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
		font-size: 13px;
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
		font-size: 13px;
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

	}

	@media (max-width: 720px) {
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

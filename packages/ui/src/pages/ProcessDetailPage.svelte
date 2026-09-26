<script lang="ts">
import {
	buildActiveTimelineTurnSummary,
	type ProcessTimelineTurnSummary,
	type TurnTraceSnapshot,
} from "@leitwerk-dev/protocol";
import { onDestroy } from "svelte";

import {
	buildChronicleProjection,
	extractChronicleReasoningDetailEntries,
} from "../chronicle/lib/chronicle-projection.js";
import {
	buildChronicleSelectableItems,
	CHRONICLE_ACTION_SECTION_ANCHOR_ID,
	CHRONICLE_PROCESS_ERROR_SECTION_ANCHOR_ID,
} from "../chronicle/lib/chronicle-selectable-items.js";

import type { ProcessDetailData } from "../lib/api.js";
import { getBrowserStorage } from "../lib/browser-storage.js";
import { shouldIgnorePlainShortcut } from "../lib/keyboard.js";
import { getPrimaryPathActiveTurnOutput } from "../lib/primary-path-detail.js";
import {
	clearProcessLaunchNotice,
	consumeProcessLaunchNotice,
} from "../lib/process-launch-notices.svelte";
import type { ProcessTerminalStatus } from "../lib/process-terminal-display.js";
import { clearDetail, detailState, loadProcessDetail } from "../lib/processes.svelte";

import { buildProcessesPath, locationStore, navigate } from "../lib/router.svelte";
import { readInspectorTarget } from "../lib/router-logic.js";
import { wsStore } from "../lib/ws.svelte";
import { createInspectorNavigation } from "./process-detail/inspector/inspector-navigation.js";
import ProcessInspector from "./process-detail/inspector/ProcessInspector.svelte";
import ProcessDetailChronicle from "./process-detail/ProcessDetailChronicle.svelte";
import ProcessDetailHeader from "./process-detail/ProcessDetailHeader.svelte";
import ProcessSummary from "./process-detail/ProcessSummary.svelte";
import { createProcessDetailActions } from "./process-detail/process-detail-actions.svelte.js";
import {
	buildJumpToLatestLabel,
	buildPendingRailItem,
} from "./process-detail/process-detail-view-model.js";

interface Props {
	instanceId: string;
}

let { instanceId }: Props = $props();

let summaryDismissed = $state(false);
const summaryStorageKey = $derived(`leitwerk:process-summary:hidden:${instanceId}`);
const waitingReport = $derived(
	$detailState.data?.process.lifecycleStatus === "waiting"
		? $detailState.data.timeline.turns.findLast(
				(turn) =>
					turn.turnId === $detailState.data?.process.selectedTurnId &&
					turn.progress?.summary?.trim(),
			)
		: null,
);

function readSummaryPreference() {
	try {
		summaryDismissed = getBrowserStorage()?.getItem(summaryStorageKey) === "true";
	} catch {
		summaryDismissed = false;
	}
}
$effect(() => {
	readSummaryPreference();
});

function setSummaryDismissed(hidden: boolean) {
	summaryDismissed = hidden;
	try {
		getBrowserStorage()?.setItem(summaryStorageKey, String(hidden));
	} catch {
		/* Keep the preference for this page when browser storage is unavailable. */
	}
}
function dismissSummary() {
	setSummaryDismissed(true);
	// The dismissed control leaves the DOM; retain a useful keyboard position.
	const title = document.getElementById(processDetailTitleId);
	title?.setAttribute("tabindex", "-1");
	title?.focus();
}
function showSummary() {
	setSummaryDismissed(false);
	closeProcessInfoOverlay();
}
function handleSummaryStorage(event: StorageEvent) {
	if (event.key === null || event.key === summaryStorageKey) readSummaryPreference();
}

let launchWarning = $state<string | null>(null);
let observedInstanceId: string | null = null;
let loadedInstanceId = $state<string | null>(null);
let observedReconnectCount = $state<number | null>(null);
const processDetailTitleId = "process-detail-title";
const processTimelineHeadingId = "process-timeline-heading";

const detailActions = createProcessDetailActions({
	get instanceId() {
		return instanceId;
	},
	get detail() {
		return $detailState.data;
	},
	reload() {
		return loadProcessDetail(instanceId);
	},
});

$effect(() => {
	if (observedInstanceId === null) {
		observedInstanceId = instanceId;
		return;
	}
	if (observedInstanceId === instanceId) {
		return;
	}
	observedInstanceId = instanceId;
	launchWarning = null;
	detailActions.reset();
	clearDetail();
});

$effect(() => {
	const reconnectCount = $wsStore.reconnectCount;
	if (loadedInstanceId === instanceId && observedReconnectCount === reconnectCount) {
		return;
	}
	loadedInstanceId = instanceId;
	observedReconnectCount = reconnectCount;
	void loadProcessDetail(instanceId);
});

onDestroy(() => {
	clearDetail();
});

$effect(() => {
	const nextWarning = consumeProcessLaunchNotice(instanceId);
	launchWarning = nextWarning?.message ?? null;
});

function handleProcessDeleted() {
	closeBlockingDetailOverlays();
	clearDetail();
	navigate(buildProcessesPath(), { replace: true });
}

function projectTimelineTurns(detail: ProcessDetailData): ProcessTimelineTurnSummary[] {
	const activeTurn = detail.primaryPath.turnState.activeTurn;
	if (!activeTurn) {
		return detail.timeline.turns;
	}
	// A live turn-start frame can supersede the synthetic in-progress row from
	// the last HTTP snapshot. There is only one active turn, so discard every
	// other stale in-progress projection before merging the live turn.
	const turns = detail.timeline.turns.filter(
		(turn) => turn.id === activeTurn.turnRecordId || turn.status !== "in_progress",
	);
	const liveOutput = getPrimaryPathActiveTurnOutput(activeTurn);
	const activeIndex = turns.findIndex((turn) => turn.id === activeTurn.turnRecordId);
	if (activeIndex >= 0) {
		return turns.map((turn, index) =>
			index === activeIndex
				? {
						...turn,
						output: liveOutput,
						status: "in_progress",
					}
				: turn,
		);
	}
	return [
		...turns,
		buildActiveTimelineTurnSummary(activeTurn, {
			summary: `Current step: ${activeTurn.turnId}`,
			output: liveOutput,
		}),
	];
}

const turnRecords = $derived.by(() => {
	const detail = $detailState.data;
	if (!detail) return [];
	return projectTimelineTurns(detail).map((turn) => ({
		...turn,
		displayTurn:
			turn.status === "in_progress" && detail.selectedTurn?.turnId === turn.turnId
				? detail.selectedTurn.description
				: turn.displayTurn,
	}));
});
const turnTraceIndex: Record<string, TurnTraceSnapshot> = {};

const chroniclePrompt = $derived({
	text: $detailState.data?.timeline.prompt.text ?? null,
	createdAt: $detailState.data?.timeline.prompt.createdAt ?? null,
});
const chronicleProjection = $derived(
	buildChronicleProjection({
		turnRecords,
		turnTraceIndex,
		turnTracePreviewIndex: $detailState.data?.timeline.tracePreviewsByTurnRecordId ?? {},
		runDetails: $detailState.data?.runDetails ?? null,
		initialUserInputText: $detailState.data?.timeline.prompt.text ?? null,
		inputs: $detailState.data?.timeline.inputs ?? [],
		leafOutcomeSnapshots: $detailState.data?.leafOutcomeSnapshots ?? [],
		definesLeafOutcome: $detailState.data?.definesLeafOutcome ?? false,
		activeTurn: $detailState.data?.primaryPath.turnState.activeTurn ?? null,
		lifecycleStatus: $detailState.data?.process.lifecycleStatus ?? null,
		selectedTurnId: $detailState.data?.process.selectedTurnId ?? null,
		processUpdatedAt: $detailState.data?.process.updatedAt ?? null,
		promptText: chroniclePrompt.text,
		promptCreatedAt: chroniclePrompt.createdAt,
	}),
);
const reasoningDetailEntries = $derived(
	extractChronicleReasoningDetailEntries(
		chronicleProjection,
		$detailState.data?.questionRequests ?? [],
	),
);
const inspectorTarget = $derived(readInspectorTarget($locationStore));
const isProcessInfoOverlayOpen = $derived(inspectorTarget?.scope === "process");
const hasBlockingDetailOverlay = $derived(inspectorTarget !== null);
let chronicle: { reveal(target: { turnRecordId?: string; turnId?: string }): void } | undefined;
const inspectorNavigation = createInspectorNavigation({
	get instanceId() {
		return instanceId;
	},
	get route() {
		return inspectorTarget;
	},
	get path() {
		return $locationStore;
	},
	reveal(target) {
		chronicle?.reveal(target);
	},
});
$effect(() => {
	$locationStore;
	void inspectorNavigation.restoreRoute();
});
const scheduledActionDetail = $derived($detailState.data?.scheduledAction ?? null);
const isTerminalProcess = $derived.by(() => {
	const lifecycleStatus = $detailState.data?.process.lifecycleStatus ?? null;
	return lifecycleStatus === "completed" || lifecycleStatus === "aborted";
});
const selectedTurnExternalTriggers = $derived(
	scheduledActionDetail ? [] : ($detailState.data?.selectedTurn?.externalTriggers ?? []),
);
const visibleExternalTriggers = $derived(isTerminalProcess ? [] : selectedTurnExternalTriggers);
const selectedTurnExternalTriggerSignals = $derived(
	$detailState.data?.timeline.externalTriggerSignals ?? [],
);
const currentTurnRecovery = $derived($detailState.data?.recovery ?? null);
const startup = $derived(
	$detailState.data?.startup ?? { authoritativeAttemptId: null, attempts: [], recovery: null },
);
const startupRecovery = $derived(startup.recovery);
const currentProcessError = $derived($detailState.data?.processError ?? null);
const pendingRailItem = $derived(
	buildPendingRailItem({
		scheduledActionDetail,
		editingScheduledActionId: detailActions.editingScheduledActionId,
		currentTurnRecovery,
		currentProcessError,
		availableActions: detailActions.availableActions,
		visibleExternalTriggers,
		selectedTurnDescription: $detailState.data?.selectedTurn?.description ?? null,
		actionSectionAnchorId: CHRONICLE_ACTION_SECTION_ANCHOR_ID,
		processErrorSectionAnchorId: CHRONICLE_PROCESS_ERROR_SECTION_ANCHOR_ID,
	}),
);
const jumpToLatestLabel = $derived(
	buildJumpToLatestLabel({
		currentTurnRecovery,
		currentProcessError,
		availableActions: detailActions.availableActions,
		scheduledActionDetail,
		hasLiveTail: chronicleProjection.liveTail !== null,
	}),
);
const chronicleSelectableItems = $derived(
	buildChronicleSelectableItems({
		projection: chronicleProjection,
		pendingRailItem,
		externalWaitingTurnId: startupRecovery ? null : $detailState.data?.selectedTurn?.turnId,
	}),
);
const terminalSummaryStatus = $derived.by((): ProcessTerminalStatus | null => {
	const lifecycleStatus = $detailState.data?.process.lifecycleStatus ?? null;
	if (lifecycleStatus === "completed" || lifecycleStatus === "aborted") {
		return lifecycleStatus;
	}
	return null;
});

const persistedModelSelectionWarning = $derived(
	$detailState.data?.persistedModelSelectionWarning ?? null,
);

function handlePageKeydown(event: KeyboardEvent) {
	if (shouldIgnorePlainShortcut(event)) return;
	if (event.key === "Escape" && inspectorTarget) {
		event.preventDefault();
		inspectorNavigation.back();
	} else if (event.key === "i" && !inspectorTarget) {
		event.preventDefault();
		toggleProcessInfoOverlay();
	}
}

function dismissLaunchWarning() {
	launchWarning = null;
	clearProcessLaunchNotice(instanceId);
}

function toggleProcessInfoOverlay() {
	if (inspectorTarget) inspectorNavigation.showChronicle();
	else inspectorNavigation.visit({ scope: "process", section: "overview" });
}
function closeProcessInfoOverlay() {
	inspectorNavigation.showChronicle();
}
function closeBlockingDetailOverlays() {
	if (inspectorTarget) inspectorNavigation.showChronicle();
}
function openReasoningDetails(turnRecordId: string, itemId?: string) {
	inspectorNavigation.visit({ scope: "execution", turnRecordId, section: "trace", itemId });
}
</script>

<svelte:window onkeydown={handlePageKeydown} onstorage={handleSummaryStorage} />

<div class="process-detail-page" data-page="process-detail" use:inspectorNavigation.observe>
	<div class="page-shell" hidden={hasBlockingDetailOverlay} inert={hasBlockingDetailOverlay ? true : undefined}>
		<ProcessDetailHeader
			{instanceId}
			titleId={processDetailTitleId}
			detail={$detailState.data}
			isProcessInfoOpen={isProcessInfoOverlayOpen}
			onToggleProcessInfo={toggleProcessInfoOverlay}
			onDeleted={handleProcessDeleted}
		/>


		{#if waitingReport?.progress?.summary && !summaryDismissed}
			<ProcessSummary summary={waitingReport.progress.summary} recordedAt={waitingReport.progressRecordedAt} onDismiss={dismissSummary} />
		{/if}

		<ProcessDetailChronicle
            bind:this={chronicle}
			{instanceId}
			detail={$detailState.data}
			loading={$detailState.loading}
			error={$detailState.error}
			projection={chronicleProjection}
			railItems={chronicleSelectableItems}
			headingId={processTimelineHeadingId}
			{terminalSummaryStatus}
			definesLeafOutcome={$detailState.data?.definesLeafOutcome ?? false}
			actionsController={detailActions}
			externalTriggers={visibleExternalTriggers}
			externalTriggerSignals={selectedTurnExternalTriggerSignals}
			selectedTurn={$detailState.data?.selectedTurn ?? null}
			recovery={currentTurnRecovery}
			{startup}
			{startupRecovery}
			processError={currentProcessError}
			{scheduledActionDetail}
			{reasoningDetailEntries}
			{hasBlockingDetailOverlay}
			{launchWarning}
			{persistedModelSelectionWarning}
			{jumpToLatestLabel}
			onDismissLaunchWarning={dismissLaunchWarning}
			onOpenReasoningDetails={openReasoningDetails}
			onCloseBlockingDetailOverlays={closeBlockingDetailOverlays}
			isProcessInfoOpen={isProcessInfoOverlayOpen}
			onToggleProcessInfo={toggleProcessInfoOverlay}
			onDeleted={handleProcessDeleted}
		/>
	</div>

  {#if inspectorTarget}
    <ProcessInspector {instanceId} target={inspectorTarget} detail={$detailState.data} error={$detailState.error}
      onNavigate={inspectorNavigation.visit} onBack={inspectorNavigation.back} onChronicle={inspectorNavigation.showChronicle}
      onReady={inspectorNavigation.restoreContent}
      onShowSummary={waitingReport && summaryDismissed ? showSummary : undefined} />
  {/if}
</div>

<style>
	.process-detail-page {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		width: 100%;
		height: 100%;
		min-height: 0;
	}

	.page-shell {
		display: flex;
		flex-direction: column;
		gap: clamp(var(--space-md), 1.6vw, var(--space-lg));
		width: 100%;
		height: 100%;
		min-height: 0;
	}

	.page-shell[hidden] {display:none;}
</style>

<script lang="ts">
import {
	buildActiveTimelineTurnSummary,
	type ProcessTimelineTurnSummary,
	type TurnTraceSnapshot,
} from "@leitwerk-dev/protocol";
import { onDestroy, tick } from "svelte";
import ChronicleReasoningDetailsOverlay from "../chronicle/components/ChronicleReasoningDetailsOverlay.svelte";
import {
	buildChronicleProjection,
	extractChronicleReasoningDetailEntries,
} from "../chronicle/lib/chronicle-projection.js";
import {
	buildChronicleSelectableItems,
	CHRONICLE_ACTION_SECTION_ANCHOR_ID,
	CHRONICLE_PROCESS_ERROR_SECTION_ANCHOR_ID,
} from "../chronicle/lib/chronicle-selectable-items.js";
import ProcessInfoOverlay from "../components/ProcessInfoOverlay.svelte";
import { fetchTurnReasoningDetail, type ProcessDetailData } from "../lib/api.js";
import { shouldIgnorePlainShortcut } from "../lib/keyboard.js";
import { getPrimaryPathActiveTurnOutput } from "../lib/primary-path-detail.js";
import {
	clearProcessLaunchNotice,
	consumeProcessLaunchNotice,
} from "../lib/process-launch-notices.svelte";
import type { ProcessTerminalStatus } from "../lib/process-terminal-display.js";
import { clearDetail, detailState, loadProcessDetail } from "../lib/processes.svelte";
import {
	buildProcessesPath,
	buildProcessPath,
	locationStore,
	navigate,
	readProcessDetailOverlay,
} from "../lib/router.svelte";
import { createToolRendererIndex } from "../lib/tool-call-rendering.js";
import { wsStore } from "../lib/ws.svelte";
import OverlayFrame from "./process-detail/OverlayFrame.svelte";
import ProcessDetailChronicle from "./process-detail/ProcessDetailChronicle.svelte";
import ProcessDetailHeader from "./process-detail/ProcessDetailHeader.svelte";
import { createProcessDetailActions } from "./process-detail/process-detail-actions.svelte.js";
import {
	buildJumpToLatestLabel,
	buildPendingRailItem,
} from "./process-detail/process-detail-view-model.js";

interface Props {
	instanceId: string;
}

let { instanceId }: Props = $props();

let launchWarning = $state<string | null>(null);
let observedInstanceId: string | null = null;
let loadedInstanceId = $state<string | null>(null);
let observedReconnectCount = $state<number | null>(null);
let processInfoFocusRestoreElement: HTMLElement | null = null;
let reasoningTraceCache = $state.raw<Record<string, TurnTraceSnapshot>>({});
let activeReasoningRequest = $state.raw<{
	key: string;
	status: "loading" | "error";
	error: string | null;
} | null>(null);
let reasoningRequestGeneration = 0;
let reasoningRequestAbortController: AbortController | null = null;

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
	processInfoFocusRestoreElement = null;
	reasoningTraceCache = {};
	activeReasoningRequest = null;
	reasoningRequestGeneration += 1;
	reasoningRequestAbortController?.abort();
	reasoningRequestAbortController = null;
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
	reasoningRequestAbortController?.abort();
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

const turnRecords = $derived($detailState.data ? projectTimelineTurns($detailState.data) : []);
const turnTraceIndex = $derived.by(() => {
	const detail = $detailState.data;
	if (!detail) {
		return {};
	}
	return Object.fromEntries(
		detail.timeline.turns.flatMap((turn) => {
			const trace = reasoningTraceCache[reasoningCacheKey(detail.session.signature, turn.id)];
			return trace ? [[turn.id, trace]] : [];
		}),
	);
});
const toolRendererIndex = $derived(createToolRendererIndex($detailState.data?.toolRenderers ?? []));
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
	extractChronicleReasoningDetailEntries(chronicleProjection),
);
const processDetailOverlay = $derived(readProcessDetailOverlay($locationStore));
const isProcessInfoOverlayOpen = $derived(processDetailOverlay.kind === "process-info");
const requestedReasoningDetailTurnRecordId = $derived(
	processDetailOverlay.kind === "reasoning" ? processDetailOverlay.turnRecordId : null,
);
const activeReasoningDetailIndex = $derived.by(() => {
	if (!requestedReasoningDetailTurnRecordId) {
		return -1;
	}
	return reasoningDetailEntries.findIndex(
		(entry) => entry.turnRecordId === requestedReasoningDetailTurnRecordId,
	);
});
const activeReasoningDetail = $derived.by(() => {
	if (activeReasoningDetailIndex < 0) {
		return null;
	}
	return reasoningDetailEntries[activeReasoningDetailIndex] ?? null;
});
const hasPreviousReasoningDetail = $derived(activeReasoningDetailIndex > 0);
const hasNextReasoningDetail = $derived(
	activeReasoningDetailIndex >= 0 && activeReasoningDetailIndex < reasoningDetailEntries.length - 1,
);
const hasBlockingDetailOverlay = $derived(
	isProcessInfoOverlayOpen || activeReasoningDetail !== null,
);

function reasoningCacheKey(sessionSignature: string | null, turnRecordId: string): string {
	return JSON.stringify([sessionSignature, turnRecordId]);
}

async function loadReasoningDetail(
	requestInstanceId: string,
	turnRecordId: string,
	sessionSignature: string | null,
) {
	const key = reasoningCacheKey(sessionSignature, turnRecordId);
	reasoningRequestAbortController?.abort();
	const controller = new AbortController();
	reasoningRequestAbortController = controller;
	const generation = ++reasoningRequestGeneration;
	activeReasoningRequest = { key, status: "loading", error: null };
	try {
		const response = await fetchTurnReasoningDetail(
			requestInstanceId,
			turnRecordId,
			sessionSignature,
			controller.signal,
		);
		const currentDetail = $detailState.data;
		if (
			generation !== reasoningRequestGeneration ||
			currentDetail?.process.id !== requestInstanceId ||
			currentDetail.session.signature !== sessionSignature ||
			requestedReasoningDetailTurnRecordId !== turnRecordId
		) {
			return;
		}
		reasoningTraceCache = { ...reasoningTraceCache, [key]: response.reasoning };
		activeReasoningRequest = null;
	} catch (error) {
		if (generation !== reasoningRequestGeneration || controller.signal.aborted) {
			return;
		}
		activeReasoningRequest = {
			key,
			status: "error",
			error: error instanceof Error ? error.message : "Couldn't load full reasoning details",
		};
	} finally {
		if (reasoningRequestAbortController === controller) {
			reasoningRequestAbortController = null;
		}
	}
}

$effect(() => {
	const detail = $detailState.data;
	const turnRecordId = requestedReasoningDetailTurnRecordId;
	if (!detail || !turnRecordId || !activeReasoningDetail || activeReasoningDetail.isLive) {
		return;
	}
	const key = reasoningCacheKey(detail.session.signature, turnRecordId);
	if (reasoningTraceCache[key] || activeReasoningRequest?.key === key) {
		return;
	}
	void loadReasoningDetail(detail.process.id, turnRecordId, detail.session.signature);
});

const activeReasoningRequestState = $derived.by(() => {
	const detail = $detailState.data;
	if (!detail || !requestedReasoningDetailTurnRecordId) {
		return null;
	}
	const key = reasoningCacheKey(detail.session.signature, requestedReasoningDetailTurnRecordId);
	return activeReasoningRequest?.key === key ? activeReasoningRequest : null;
});

function retryReasoningDetail() {
	const detail = $detailState.data;
	const turnRecordId = requestedReasoningDetailTurnRecordId;
	if (!detail || !turnRecordId) {
		return;
	}
	void loadReasoningDetail(detail.process.id, turnRecordId, detail.session.signature);
}
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
const startupRecovery = $derived($detailState.data?.startupRecovery ?? null);
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
	}),
);
const terminalSummaryStatus = $derived.by((): ProcessTerminalStatus | null => {
	const lifecycleStatus = $detailState.data?.process.lifecycleStatus ?? null;
	if (lifecycleStatus === "completed" || lifecycleStatus === "aborted") {
		return lifecycleStatus;
	}
	return null;
});
const processUsageEstimate = $derived($detailState.data?.usageEstimate ?? null);
const persistedModelSelectionWarning = $derived(
	$detailState.data?.persistedModelSelectionWarning ?? null,
);

function handlePageKeydown(event: KeyboardEvent) {
	if (shouldIgnorePlainShortcut(event) || !$detailState.data) {
		return;
	}

	if (event.key === "Escape" && isProcessInfoOverlayOpen) {
		event.preventDefault();
		closeProcessInfoOverlay();
		return;
	}

	if (isProcessInfoOverlayOpen || activeReasoningDetail !== null) {
		return;
	}

	if (event.key === "i") {
		event.preventDefault();
		toggleProcessInfoOverlay();
	}
}

function dismissLaunchWarning() {
	launchWarning = null;
	clearProcessLaunchNotice(instanceId);
}

function navigateToProcessBase(options: { replace?: boolean } = { replace: true }) {
	navigate(buildProcessPath(instanceId), options);
}

function rememberProcessInfoFocusRestoreTarget() {
	processInfoFocusRestoreElement =
		document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function restoreProcessInfoFocus() {
	const restoreTarget = processInfoFocusRestoreElement;
	processInfoFocusRestoreElement = null;
	if (!restoreTarget?.isConnected) {
		return;
	}
	void tick().then(() => {
		if (restoreTarget.isConnected) {
			restoreTarget.focus();
		}
	});
}

function toggleProcessInfoOverlay() {
	if (!$detailState.data) {
		return;
	}
	if (isProcessInfoOverlayOpen) {
		closeProcessInfoOverlay();
		return;
	}
	rememberProcessInfoFocusRestoreTarget();
	navigate(buildProcessPath(instanceId, { overlay: "process-info" }), { replace: true });
}

function closeProcessInfoOverlay(options: { replace?: boolean } = { replace: true }) {
	if (processDetailOverlay.kind === "process-info") {
		navigateToProcessBase(options);
		restoreProcessInfoFocus();
	}
}

function closeProcessDetailOverlay(options: { replace?: boolean } = { replace: true }) {
	if (processDetailOverlay.kind !== "none") {
		if (processDetailOverlay.kind === "process-info") {
			restoreProcessInfoFocus();
		}
		navigateToProcessBase(options);
	}
}

function closeBlockingDetailOverlays() {
	closeProcessDetailOverlay({ replace: true });
}

function openReasoningDetails(turnRecordId: string) {
	navigate(buildProcessPath(instanceId, { overlay: "reasoning", turnRecordId }), { replace: true });
}

function closeReasoningDetails(options: { replace?: boolean } = { replace: true }) {
	if (processDetailOverlay.kind === "reasoning") {
		navigateToProcessBase(options);
	}
}

function openPreviousReasoningDetails() {
	if (activeReasoningDetailIndex <= 0) {
		return;
	}
	const turnRecordId = reasoningDetailEntries[activeReasoningDetailIndex - 1]?.turnRecordId ?? null;
	if (!turnRecordId) {
		return;
	}
	openReasoningDetails(turnRecordId);
}

function openNextReasoningDetails() {
	if (
		activeReasoningDetailIndex < 0 ||
		activeReasoningDetailIndex >= reasoningDetailEntries.length - 1
	) {
		return;
	}
	const turnRecordId = reasoningDetailEntries[activeReasoningDetailIndex + 1]?.turnRecordId ?? null;
	if (!turnRecordId) {
		return;
	}
	openReasoningDetails(turnRecordId);
}
</script>

<svelte:window onkeydown={handlePageKeydown} />

<div class="process-detail-page" data-page="process-detail">
	<div class="page-shell" inert={hasBlockingDetailOverlay ? true : undefined}>
		<ProcessDetailHeader
			{instanceId}
			titleId={processDetailTitleId}
			detail={$detailState.data}
			isProcessInfoOpen={isProcessInfoOverlayOpen}
			onToggleProcessInfo={toggleProcessInfoOverlay}
			onDeleted={handleProcessDeleted}
		/>

		<ProcessDetailChronicle
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
		/>
	</div>

	{#if isProcessInfoOverlayOpen && $detailState.data}
		<OverlayFrame
			kind="process-info"
			closeLabel="Close process info"
			onClose={() => closeProcessDetailOverlay()}
		>
			<ProcessInfoOverlay
				detail={$detailState.data}
				{processUsageEstimate}
				onClose={() => closeProcessInfoOverlay()}
				railItems={chronicleSelectableItems}
			/>
		</OverlayFrame>
	{:else if activeReasoningDetail}
		<OverlayFrame
			kind="reasoning"
			closeLabel="Close reasoning details"
			onClose={() => closeProcessDetailOverlay()}
		>
			{#if activeReasoningRequestState?.status === "error"}
				<div class="reasoning-load-error" role="status" data-section="reasoning-load-error">
					<span>{activeReasoningRequestState.error}</span>
					<button type="button" onclick={retryReasoningDetail}>Retry</button>
				</div>
			{:else if activeReasoningRequestState?.status === "loading"}
				<p class="sr-only" role="status">Loading full reasoning details…</p>
			{/if}
			<ChronicleReasoningDetailsOverlay
				entry={activeReasoningDetail}
				{toolRendererIndex}
				hasPrevious={hasPreviousReasoningDetail}
				hasNext={hasNextReasoningDetail}
				onClose={() => closeReasoningDetails()}
				onPrevious={() => openPreviousReasoningDetails()}
				onNext={() => openNextReasoningDetails()}
			/>
		</OverlayFrame>
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

	.reasoning-load-error {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
		justify-content: space-between;
		padding: var(--space-sm) var(--space-md);
		border-bottom: 1px solid var(--chronicle-border);
		color: var(--chronicle-danger-text);
		background: var(--chronicle-danger-surface-soft);
		font-size: var(--type-body-sm);
	}

	.reasoning-load-error button {
		min-height: 36px;
		padding: 0 var(--space-md);
		border: 1px solid var(--chronicle-border-strong);
		border-radius: 999px;
		background: var(--chronicle-surface);
		color: var(--chronicle-text);
		font: inherit;
		font-weight: 650;
		cursor: pointer;
	}

	.reasoning-load-error button:focus-visible {
		outline: 2px solid var(--chronicle-accent);
		outline-offset: 2px;
	}
</style>

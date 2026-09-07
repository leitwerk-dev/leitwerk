<script lang="ts">
import type { ProcessQuestionRequest, ProcessToolApprovalRequest } from "@leitwerk-dev/domain";
import type {
	ProcessExternalTriggerSignal,
	ProcessStartupSummary,
	StartupRecoverySummary,
} from "@leitwerk-dev/protocol";
import { SvelteMap } from "svelte/reactivity";
import type {
	ProcessExternalTriggerSummary,
	ProcessModelConfigurationView,
	ProcessSelectedTurnSummary,
	ScheduledActionDetail,
} from "../../lib/api";
import type {
	ActionSectionController,
	LiveTailController,
	RecoveryController,
	ScheduledActionController,
} from "../lib/action-bindings.js";
import type { ChronicleProjection, ChronicleTimelineItem } from "../lib/chronicle-projection.js";
import {
	CHRONICLE_ACTION_SECTION_ANCHOR_ID,
	CHRONICLE_PROCESS_ERROR_SECTION_ANCHOR_ID,
} from "../lib/chronicle-selectable-items.js";
import type { ChronicleTicketArtifact } from "../lib/chronicle-ticket-artifact.js";
import ChronicleActionSection from "./ChronicleActionSection.svelte";
import ChronicleLeafOutcomePlaceholder from "./ChronicleLeafOutcomePlaceholder.svelte";
import ChronicleLeafOutcomeSection from "./ChronicleLeafOutcomeSection.svelte";
import ChronicleLiveTail from "./ChronicleLiveTail.svelte";
import ChronicleOperatorInputSection from "./ChronicleOperatorInputSection.svelte";
import ChronicleProcessErrorSection from "./ChronicleProcessErrorSection.svelte";
import ChroniclePromptSection from "./ChroniclePromptSection.svelte";
import ChronicleRecoverySection from "./ChronicleRecoverySection.svelte";
import ChronicleScheduledActionSection from "./ChronicleScheduledActionSection.svelte";
import ChronicleStartupHistory from "./ChronicleStartupHistory.svelte";
import ChronicleStartupRecoverySection from "./ChronicleStartupRecoverySection.svelte";
import ChronicleToolApproval from "./ChronicleToolApproval.svelte";
import ChronicleTurnCluster from "./ChronicleTurnCluster.svelte";

interface Props {
	instanceId: string;
	projection: ChronicleProjection;
	questionRequests?: readonly ProcessQuestionRequest[];
	toolApprovalRequests?: readonly ProcessToolApprovalRequest[];
	activeAnchorId: string | null;
	definesLeafOutcome: boolean;
	actionSectionController: ActionSectionController;
	scheduledActionController: ScheduledActionController;
	recoveryController: RecoveryController;
	liveTailController: LiveTailController;
	externalTriggers: readonly ProcessExternalTriggerSummary[];
	externalTriggerSignals: readonly ProcessExternalTriggerSignal[];
	selectedTurn?: ProcessSelectedTurnSummary | null;
	scheduledAction?: ScheduledActionDetail | null;
	recovery?: {
		turnRecordId: string;
		title: string;
		summary: string;
		guidance?: string;
		technicalDetail?: string | null;
		defaultContinuePrompt: string;
		canContinue: boolean;
		supportsModelOverride: boolean;
		defaultModelProfileId: string | null;
		providerOptions: Record<string, string>;
	} | null;
	startup: ProcessStartupSummary;
	startupRecovery?: StartupRecoverySummary | null;
	processError?: {
		title: string;
		summary: string;
		guidance?: string;
		technicalDetail?: string | null;
	} | null;
	modelConfiguration: ProcessModelConfigurationView;
	onOpenReasoningDetails: (turnRecordId: string) => void;
	onDraftTicket?: (artifact: ChronicleTicketArtifact) => void;
	hasTerminalSummary?: boolean;
}

let {
	instanceId,
	projection,
	questionRequests = [],
	toolApprovalRequests = [],
	activeAnchorId,
	definesLeafOutcome,
	actionSectionController: actionBindings,
	scheduledActionController,
	recoveryController,
	liveTailController,
	externalTriggers = [],
	externalTriggerSignals = [],
	selectedTurn = null,
	scheduledAction = null,
	recovery = null,
	startup,
	startupRecovery = null,
	processError = null,
	modelConfiguration,
	onOpenReasoningDetails,
	onDraftTicket,
	hasTerminalSummary = false,
}: Props = $props();

const latestTimelineItem = $derived.by(() => projection.timelineItems.at(-1) ?? null);
const questionRequestsByTurn = $derived.by(() => {
	const grouped = new SvelteMap<
		string,
		{ open: ProcessQuestionRequest | null; closed: ProcessQuestionRequest[] }
	>();
	for (const request of questionRequests) {
		const requests = grouped.get(request.turnRecordId) ?? { open: null, closed: [] };
		if (request.status === "open") requests.open = request;
		else requests.closed.push(request);
		grouped.set(request.turnRecordId, requests);
	}
	return grouped;
});

function questionRequestsForTurn(turnRecordId: string): ProcessQuestionRequest[] {
	const requests = questionRequestsByTurn.get(turnRecordId);
	return requests ? [...requests.closed, ...(requests.open ? [requests.open] : [])] : [];
}

function chronicleItemKey(item: ChronicleTimelineItem, index: number): string {
	switch (item.kind) {
		case "prompt":
			return `prompt-${item.anchorId}`;
		case "turn_cluster":
			return `turn-${item.turnRecordId}`;
		case "operator_input":
			return `input-${item.inputId}`;
		case "leaf_outcome":
			return `leaf-${item.snapshotId}`;
		case "live_tail":
			return `live-${item.turnRecordId}`;
		case "leaf_outcome_placeholder":
			return `leaf-placeholder-${item.latestTurnTitle ?? index}`;
		default:
			return `${item.kind}-${index}`;
	}
}

const hasTrailingProcessSection = $derived(
	scheduledAction !== null ||
		recovery !== null ||
		startupRecovery !== null ||
		processError !== null ||
		actionBindings.actionSectionActions.length > 0 ||
		externalTriggers.length > 0,
);
const shouldRenderInlineTrailingProcessSection = $derived(
	hasTrailingProcessSection &&
		recovery === null &&
		startupRecovery === null &&
		projection.timelineItems.length > 0,
);
const shouldRenderTrailingAfterFlow = $derived(
	hasTrailingProcessSection &&
		(recovery !== null || startupRecovery !== null || projection.timelineItems.length === 0),
);

function shouldRenderActionSection(item: ChronicleTimelineItem): boolean {
	return shouldRenderInlineTrailingProcessSection && item === latestTimelineItem;
}
</script>

{#snippet trailingProcessSection()}
	{#if scheduledAction}
		<ChronicleScheduledActionSection
			anchorId={CHRONICLE_ACTION_SECTION_ANCHOR_ID}
			isFocused={activeAnchorId === CHRONICLE_ACTION_SECTION_ANCHOR_ID}
			scheduledAction={scheduledAction}
			busy={scheduledActionController.scheduledActionBusy}
			error={scheduledActionController.scheduledActionError}
			onEdit={scheduledActionController.editScheduledAction}
			onCancel={scheduledActionController.cancelScheduledAction}
		/>
	{:else if recovery}
		{#key `${recovery.turnRecordId}:${recovery.defaultContinuePrompt}`}
			<ChronicleRecoverySection
				anchorId={CHRONICLE_ACTION_SECTION_ANCHOR_ID}
				{instanceId}
				isFocused={activeAnchorId === CHRONICLE_ACTION_SECTION_ANCHOR_ID}
				title={recovery.title}
				summary={recovery.summary}
				guidance={recovery.guidance}
				technicalDetail={recovery.technicalDetail}
				turnRecordId={recovery.turnRecordId}
				canContinue={recovery.canContinue}
				supportsModelOverride={recovery.supportsModelOverride}
				continueBusy={recoveryController.continueBusyTurnRecordId === recovery.turnRecordId}
				continueError={
					recoveryController.continueError?.turnRecordId === recovery.turnRecordId
						? recoveryController.continueError.message
						: null
				}
				continuePrompt={recovery.defaultContinuePrompt}
				retryBusy={recoveryController.retryBusy}
				retryError={recoveryController.retryError}
				modelProfiles={modelConfiguration.availableProfiles}
				defaultModelProfileId={recovery.defaultModelProfileId}
				defaultProviderOptions={recovery.providerOptions}
				onContinue={(prompt, modelProfileId, providerOptions) =>
					recoveryController.continueFailedTurn(
						recovery.turnRecordId,
						prompt,
						modelProfileId,
						providerOptions,
					)}
				onRetry={recoveryController.retryFailedTurn}
			/>
		{/key}
	{:else if startupRecovery}
		<ChronicleStartupRecoverySection
			{instanceId}
			recovery={startupRecovery}
			modelProfiles={modelConfiguration.availableProfiles}
			defaultModelProfileId={startupRecovery.defaultModelProfileId}
			busy={recoveryController.startupRetryBusy}
			error={recoveryController.startupRetryError}
			onRetry={recoveryController.retryStartup}
		/>
	{:else if processError}
		<ChronicleProcessErrorSection
			anchorId={CHRONICLE_PROCESS_ERROR_SECTION_ANCHOR_ID}
			isFocused={activeAnchorId === CHRONICLE_PROCESS_ERROR_SECTION_ANCHOR_ID}
			title={processError.title}
			summary={processError.summary}
			guidance={processError.guidance}
			technicalDetail={processError.technicalDetail}
		/>
	{:else}
		<ChronicleActionSection
			anchorId={CHRONICLE_ACTION_SECTION_ANCHOR_ID}
			isFocused={activeAnchorId === CHRONICLE_ACTION_SECTION_ANCHOR_ID}
			actionSectionController={actionBindings}
			externalTriggers={externalTriggers}
			externalTriggerSignals={externalTriggerSignals}
			selectedTurn={selectedTurn}
			{modelConfiguration}
		/>
	{/if}
{/snippet}

<div class="chronicle-flow" class:has-terminal-summary={hasTerminalSummary} data-section="chronicle-flow">
	<ChronicleStartupHistory {startup} />
	{#each toolApprovalRequests.filter((request) => request.status === "open") as request (request.id)}
		<ChronicleToolApproval {request} />
	{/each}
	{#each projection.timelineItems as item, index (chronicleItemKey(item, index))}
		{#if item.kind === "prompt"}
			<ChroniclePromptSection prompt={item} isFocused={activeAnchorId === item.anchorId} />
		{:else if item.kind === "turn_cluster"}
			<ChronicleTurnCluster
				cluster={item}
				isFocused={activeAnchorId === item.anchorId}
				compressHistory={item !== latestTimelineItem}
				questionRequests={questionRequestsForTurn(item.turnRecordId)}
				onOpenReasoningDetails={onOpenReasoningDetails}
				onDraftTicket={onDraftTicket}
			/>
		{:else if item.kind === "operator_input"}
			<ChronicleOperatorInputSection section={item} />
		{:else if item.kind === "leaf_outcome"}
			<ChronicleLeafOutcomeSection
				section={item}
				isFocused={activeAnchorId === item.anchorId}
				compressHistory={item !== latestTimelineItem}
				onDraftTicket={onDraftTicket}
			/>
		{:else if item.kind === "leaf_outcome_placeholder"}
			<ChronicleLeafOutcomePlaceholder latestTurnTitle={item.latestTurnTitle} />
		{:else if item.kind === "live_tail"}
			<ChronicleLiveTail
				liveTail={item}
				questionRequest={questionRequestsByTurn.get(item.turnRecordId)?.open ?? null}
				isFocused={activeAnchorId === item.anchorId}
				onOpenReasoningDetails={onOpenReasoningDetails}
				onAbortTurn={item.turnType === "llm" ? liveTailController.abortRunningTurn : null}
				abortBusy={liveTailController.abortTurnBusy}
				abortError={liveTailController.abortTurnError}
			/>
		{/if}

		{#if shouldRenderActionSection(item)}
			{@render trailingProcessSection()}
		{/if}
	{/each}

	{#if shouldRenderTrailingAfterFlow}
		{@render trailingProcessSection()}
	{/if}
</div>

<style>
	.chronicle-flow {
		display: flex;
		flex-direction: column;
		justify-content: flex-start;
		min-height: 100%;
		gap: clamp(var(--space-md), 2vw, var(--space-lg));
		padding-bottom: var(--space-xl);
	}

	.chronicle-flow.has-terminal-summary {
		min-height: 0;
		padding-bottom: 0;
	}
</style>

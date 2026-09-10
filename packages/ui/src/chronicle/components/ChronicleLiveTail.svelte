<script lang="ts">
import type { ProcessQuestionRequest } from "@leitwerk-dev/domain";
import { formatDefinition } from "../../lib/format.js";
import type { ChronicleLiveTailItem } from "../lib/chronicle-projection.js";
import { formatChronicleCost } from "../lib/formatting.js";
import ChronicleEntryHeader from "./ChronicleEntryHeader.svelte";
import ChronicleExpandButton from "./ChronicleExpandButton.svelte";
import ChronicleThinkingSection from "./ChronicleThinkingSection.svelte";
import ChronicleTurnDetailsButton from "./ChronicleTurnDetailsButton.svelte";

interface Props {
	liveTail: ChronicleLiveTailItem;
	questionRequests?: readonly ProcessQuestionRequest[];
	isFocused: boolean;
	onOpenReasoningDetails: (turnRecordId: string) => void;
	onAbortTurn?: (() => Promise<void> | void) | null;
	abortBusy?: boolean;
	abortError?: string | null;
}

let {
	liveTail,
	questionRequests = [],
	isFocused,
	onOpenReasoningDetails,
	onAbortTurn = null,
	abortBusy = false,
	abortError = null,
}: Props = $props();

let confirmingStop = $state(false);
const openQuestionRequest = $derived(
	questionRequests.find((request) => request.status === "open") ?? null,
);
const hasReasoning = $derived(
	Boolean(
		liveTail.reasoningSection &&
			(liveTail.reasoningSection.text.trim() ||
				liveTail.reasoningSection.preview.trim() ||
				liveTail.reasoningSection.toolCallCount ||
				liveTail.reasoningSection.traceItemCount),
	),
);

function requestStop() {
	if (!confirmingStop) {
		confirmingStop = true;
		return;
	}
	void onAbortTurn?.();
}

function cancelStop() {
	confirmingStop = false;
}

const screenReaderStatus = $derived.by(() => {
	const statusParts = [
		openQuestionRequest
			? "Answers requested. The active turn is paused for your response."
			: `${liveTail.stateLabel}: ${liveTail.title}.`,
	];
	if (liveTail.toolCall) {
		statusParts.push(`Current action ${formatDefinition(liveTail.toolCall.toolName)}.`);
	}
	return statusParts.join(" ");
});
</script>

<section
	id={liveTail.anchorId}
	class="live-tail"
	class:is-focused={isFocused}
	data-anchor-id={liveTail.anchorId}
	data-focused={isFocused ? "true" : "false"}
	data-live-state={liveTail.state}
	data-section="live-tail"
	data-turn-id={liveTail.turnId}
	data-turn-record-id={liveTail.turnRecordId}
>
	<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{screenReaderStatus}</p>
	<div class="live-tail-body">
		<ChronicleEntryHeader
			title={liveTail.title}
			kind={liveTail.turnType === "llm" ? "llm" : "system"}
			metadata={[liveTail.modelProfileId, liveTail.usage?.cost ? formatChronicleCost(liveTail.usage.cost.total) : null].filter(Boolean).join(" · ")}
			timestamp={liveTail.facts.startedAt}
			duration={openQuestionRequest ? "Paused" : "Running"}
		/>
		{#if !openQuestionRequest}<p class="live-copy" role="status">{liveTail.stateLabel}{#if liveTail.toolCall} · {formatDefinition(liveTail.toolCall.toolName)}{/if}</p>{/if}
		{#if liveTail.state === "streaming"}
			<div class="live-result"><p>{liveTail.copy}</p></div>
		{:else if !liveTail.reasoningSection && liveTail.state !== "tool_running"}
			<p class="live-copy">{liveTail.copy}</p>
		{/if}

		{#if liveTail.reasoningSection || questionRequests.length > 0}
			<ChronicleThinkingSection
				text={liveTail.reasoningSection?.text ?? ""}
				preview={liveTail.reasoningSection?.preview ?? ""}
				previewTruncated={liveTail.reasoningSection?.previewTruncated ?? false}
				traceItemCount={liveTail.reasoningSection?.traceItemCount ?? 0}
				{questionRequests}
				isLive={true}
			/>
		{/if}

		{#if onAbortTurn}
			<div class="live-tail-controls">
				{#if abortError}
					<p class="live-tail-error" role="alert">{abortError}</p>
				{/if}
				{#if confirmingStop}
					<div class="stop-confirm">
						<p class="stop-confirm-copy">
							Stop this turn? The work so far is saved, and you can continue from it or go back
							and pick a different action.
						</p>
						<div class="stop-confirm-actions">
							<button
								type="button"
								class="stop-cancel"
								data-pressable="true"
								disabled={abortBusy}
								onclick={cancelStop}
							>
								Keep running
							</button>
							<button
								type="button"
								class="stop-confirm-btn"
								data-pressable="true"
								disabled={abortBusy}
								onclick={requestStop}
							>
								{abortBusy ? "Stopping…" : "Stop turn"}
							</button>
						</div>
					</div>
				{:else}
					<button
						type="button"
						class="stop-trigger"
						data-pressable="true"
						disabled={abortBusy}
						onclick={requestStop}
					>
						Stop turn
					</button>
				{/if}
			</div>
		{/if}
		{#if liveTail.turnType === "llm" || hasReasoning}
			<div class="live-footer">
				{#if hasReasoning}<ChronicleExpandButton expanded={false} collapsedLabel="Expand reasoning" dataAction="open-reasoning-details" ariaLabel="Expand reasoning" onClick={() => onOpenReasoningDetails(liveTail.turnRecordId)} />{/if}
				{#if liveTail.turnType === "llm"}<ChronicleTurnDetailsButton title={liveTail.title} onClick={() => onOpenReasoningDetails(liveTail.turnRecordId)} />{/if}
			</div>
		{/if}
	</div>
</section>

<style>
	.live-tail { padding: 14px; border: 1px solid color-mix(in srgb, var(--chronicle-accent) 35%, var(--chronicle-border)); border-radius: 10px; background: var(--chronicle-card-surface); scroll-margin-top: var(--space-sm); }
	.live-tail.is-focused { border-color: var(--chronicle-accent); }
	.live-tail-body { display: flex; flex-direction: column; gap: 10px; }
	.live-footer { display: flex; align-items: center; justify-content: flex-end; gap: 14px; }
	.live-copy { margin: 0; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); line-height: 1.5; }

	.live-result { padding: 10px 12px; border-radius: 6px; background: color-mix(in srgb, var(--chronicle-accent) 6%, var(--chronicle-card-surface)); }
	.live-result p { max-width: 72ch; margin: 0; color: var(--chronicle-text); font-size: var(--type-body); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
	.live-tail-controls {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-top: 4px;
	}

	.live-tail-error {
		margin: 0;
		padding: 10px 12px;
		border-radius: 12px;
		background: var(--chronicle-danger-surface);
		border: 1px solid var(--chronicle-danger-border);
		font-size: 13px;
		line-height: 1.45;
		color: var(--chronicle-danger-text);
	}

	.stop-trigger {
		align-self: flex-start;
		min-height: 34px;
		padding: 0 14px;
		border-radius: 999px;
		border: 1px solid var(--chronicle-danger-border);
		background: var(--chronicle-card-surface);
		color: var(--chronicle-danger-text);
		font: inherit;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}

	.stop-trigger:hover:not(:disabled) {
		background: var(--chronicle-danger-surface);
	}

	.stop-trigger:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.stop-confirm {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px;
		border-radius: 14px;
		border: 1px solid var(--chronicle-danger-border);
		background: var(--chronicle-danger-surface-soft);
	}

	.stop-confirm-copy {
		margin: 0;
		font-size: 13px;
		line-height: 1.45;
		color: var(--chronicle-text);
	}

	.stop-confirm-actions {
		display: flex;
		gap: 8px;
	}

	.stop-cancel,
	.stop-confirm-btn {
		min-height: 34px;
		padding: 0 14px;
		border-radius: 999px;
		font: inherit;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}

	.stop-cancel {
		border: 1px solid var(--chronicle-border-strong);
		background: var(--chronicle-card-surface);
		color: var(--chronicle-text);
	}

	.stop-cancel:hover:not(:disabled) {
		background: var(--chronicle-panel-muted);
	}

	.stop-confirm-btn {
		border: 1px solid var(--chronicle-danger-border);
		background: var(--chronicle-danger);
		color: var(--chronicle-text-on-accent);
	}

	.stop-confirm-btn:hover:not(:disabled) {
		opacity: 0.9;
	}

	.stop-cancel:disabled,
	.stop-confirm-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

</style>

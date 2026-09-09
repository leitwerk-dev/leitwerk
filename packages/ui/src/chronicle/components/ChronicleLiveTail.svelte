<script lang="ts">
import type { ProcessQuestionRequest } from "@leitwerk-dev/domain";
import { formatDefinition } from "../../lib/format.js";
import type { ChronicleLiveTailItem } from "../lib/chronicle-projection.js";
import ChronicleExpandButton from "./ChronicleExpandButton.svelte";
import ChronicleThinkingSection from "./ChronicleThinkingSection.svelte";

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
		<div class="live-tail-heading">
			<div class="live-heading-copy">
				<p class="live-eyebrow">{openQuestionRequest ? "Operator input needed" : liveTail.stateLabel}</p>
				<h3>{openQuestionRequest ? "Waiting for your answers" : liveTail.title}</h3>
				{#if liveTail.pathLabel || liveTail.modelProfileId}
					<div class="live-meta-row">
						{#if liveTail.pathLabel}
							<p class="live-meta">{liveTail.pathLabel}</p>
						{/if}
						{#if liveTail.modelProfileId}
							<span class="model-label">{liveTail.modelProfileId}</span>
						{/if}
					</div>
				{/if}
			</div>
		</div>

		{#if liveTail.reasoningSection || questionRequests.length > 0}
			<ChronicleThinkingSection
				text={liveTail.reasoningSection?.text ?? ""}
				preview={liveTail.reasoningSection?.preview ?? ""}
				previewTruncated={liveTail.reasoningSection?.previewTruncated ?? false}
				toolCallCount={liveTail.reasoningSection?.toolCallCount ?? 0}
				traceItemCount={liveTail.reasoningSection?.traceItemCount ?? 0}
				{questionRequests}
				onOpenDetails={() => onOpenReasoningDetails(liveTail.turnRecordId)}
				isLive={true}
			/>
		{:else}
			<p class="live-copy">{liveTail.copy}</p>
			{#if liveTail.turnType === "llm"}
				<ChronicleExpandButton
					expanded={false}
					collapsedLabel="Expand reasoning"
					ariaLabel="Expand reasoning"
					dataAction="open-reasoning-details"
					onClick={() => onOpenReasoningDetails(liveTail.turnRecordId)}
				/>
			{/if}
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
	</div>
</section>

<style>
	.live-tail {
		padding: 22px 0 8px;
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 80%, white 20%);
		scroll-margin-top: 28px;
	}

	.live-tail-body {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 18px 18px 20px;
		border-radius: 18px;
		border: 1px solid color-mix(in srgb, var(--chronicle-accent) 20%, var(--chronicle-border) 80%);
		background: color-mix(in srgb, white 90%, var(--chronicle-accent-soft) 10%);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45);
	}

	.live-tail.is-focused .live-tail-body {
		border-color: color-mix(in srgb, var(--chronicle-accent) 32%, var(--chronicle-border) 68%);
	}

	.live-tail-heading {
		display: flex;
		align-items: start;
		gap: 12px;
	}

	.live-heading-copy {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.live-eyebrow {
		margin: 0;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--chronicle-text) 64%, var(--chronicle-accent) 36%);
	}

	.live-tail h3 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 20px;
		font-weight: 650;
		line-height: 1.18;
		color: var(--chronicle-text);
	}

	.live-meta,
	.live-copy {
		margin: 0;
		font-size: 13px;
		line-height: 1.55;
		color: var(--chronicle-text-muted);
	}

	.live-meta-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.model-label {
		font-size: 11px;
		font-weight: 500;
		color: var(--chronicle-text-faint);
		padding: 2px 6px;
		background: color-mix(in srgb, var(--chronicle-panel-muted) 70%, transparent 30%);
		border-radius: 4px;
	}

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

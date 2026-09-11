<script lang="ts">
import { markdownToPlainText, truncateText } from "../../lib/markdown.js";
import type { ChronicleLeafOutcomeItem } from "../lib/chronicle-projection.js";
import type { ChronicleTicketArtifact } from "../lib/chronicle-ticket-artifact.js";
import ChronicleCreateIssueButton from "./ChronicleCreateIssueButton.svelte";
import ChronicleEntryHeader from "./ChronicleEntryHeader.svelte";
import ChronicleExpandButton from "./ChronicleExpandButton.svelte";
import ChronicleLeafOutcomeRendererHost from "./ChronicleLeafOutcomeRendererHost.svelte";
import ChronicleMarkdown from "./ChronicleMarkdown.svelte";

interface Props {
	section: ChronicleLeafOutcomeItem;
	isFocused: boolean;
	compressHistory?: boolean;
	onDraftTicket?: (artifact: ChronicleTicketArtifact) => void;
}

let { section, isFocused, compressHistory = false, onDraftTicket }: Props = $props();
let expandedHistoryOutcome = $state<boolean | null>(null);

const shouldCompressOutcome = $derived(
	section.status !== "capture_error" && !(expandedHistoryOutcome ?? !compressHistory),
);

function summarizeLeafOutcome(section: ChronicleLeafOutcomeItem): string {
	if (section.fallbackMarkdown) {
		const plainText = markdownToPlainText(section.fallbackMarkdown);
		if (plainText) {
			return truncateText(plainText, 190);
		}
	}
	if (section.ownerTurnTitle) {
		return `Result preview for ${section.ownerTurnTitle}.`;
	}
	return section.status === "capture_error"
		? "Result preview needs attention. Expand for fallback details."
		: "Result preview recorded. Expand to inspect the full result.";
}

function expandHistoryOutcome() {
	expandedHistoryOutcome = shouldCompressOutcome;
}
</script>

<section
	id={section.anchorId}
	class="leaf-outcome-block"
	class:is-focused={isFocused}
	class:is-warning={section.status === "capture_error"}
	data-anchor-id={section.anchorId}
	data-focused={isFocused ? "true" : "false"}
	data-section="leaf-outcome"
	data-ticket-result-artifact={`leaf_outcome:${section.leafEntryId}`}
	data-ticket-result-durable={section.status === "ready" ? "true" : "false"}
	data-status={section.status}
	data-snapshot-id={section.snapshotId}
	data-renderer-mode={section.status === "ready" && section.rendererId ? "runtime" : "fallback"}
>
	<div class="leaf-outcome-shell">
		<ChronicleEntryHeader title="Turn result" kind="result" metadata={section.ownerTurnTitle} timestamp={section.anchoredAt} />
		<div class="leaf-result-actions">
			<ChronicleExpandButton expanded={!shouldCompressOutcome} expandedLabel="Collapse result" collapsedLabel="Expand result" class="expand-outcome-button" dataPressable={true} onClick={expandHistoryOutcome} />
		</div>

		{#if shouldCompressOutcome}
			<p class="leaf-outcome-summary">{summarizeLeafOutcome(section)}</p>
		{/if}

		<div class="leaf-outcome-content" class:is-compressed={shouldCompressOutcome} aria-hidden={shouldCompressOutcome ? "true" : undefined}>
		{#if section.status === "capture_error"}
			<div class="warning-shell">
				<div class="warning-header">
					<div>
						<p class="warning-title">Result preview unavailable</p>
						<p class="warning-copy">
							{section.fallbackMarkdown
								? "We couldn't capture the result preview for this step. The fallback details are shown below."
								: "We couldn't capture the result preview for this step."}
						</p>
					</div>
				</div>
				<details class="warning-technical">
					<summary>Technical details</summary>
					<dl class="warning-details">
						<dt>Renderer</dt>
						<dd>{section.rendererId ?? "Not available"}</dd>
						<dt>Snapshot</dt>
						<dd>{section.snapshotId}</dd>
						{#if section.warningMessage}
							<dt>Message</dt>
							<dd>{section.warningMessage}</dd>
						{/if}
						{#if section.warningCode}
							<dt>Code</dt>
							<dd>{section.warningCode}</dd>
						{/if}
					</dl>
				</details>
				{#if section.fallbackMarkdown}
					<ChronicleMarkdown markdown={section.fallbackMarkdown} className="leaf-outcome-markdown" />
				{/if}
			</div>
		{:else if section.rendererId}
			<ChronicleLeafOutcomeRendererHost
				instanceId={section.instanceId}
				snapshotId={section.snapshotId}
				leafEntryId={section.leafEntryId}
				turnRecordId={section.turnRecordId}
				createdAt={section.createdAt}
				schemaVersion={section.schemaVersion}
				rendererId={section.rendererId}
				props={section.props}
				fallbackMarkdown={section.fallbackMarkdown}
				processLifecycleStatus={section.processLifecycleStatus}
				processSelectedTurnId={section.processSelectedTurnId}
				processUpdatedAt={section.processUpdatedAt}
			/>
		{:else if section.fallbackMarkdown}
			<ChronicleMarkdown markdown={section.fallbackMarkdown} className="leaf-outcome-markdown" />
		{:else}
			<p class="leaf-outcome-empty">This result has no text preview to show here.</p>
		{/if}
		</div>
		{#if onDraftTicket && section.status === "ready"}
			<div class="leaf-result-actions"><ChronicleCreateIssueButton {onDraftTicket} artifact={{ kind: "leaf_outcome", leafEntryId: section.leafEntryId }} /></div>
		{/if}
	</div>
</section>

<style>
	.leaf-outcome-block {
		padding: 0;
		scroll-margin-top: var(--space-xl);
	}

	.leaf-outcome-shell { display: grid; gap: 8px; padding: 14px; border: 1px solid var(--chronicle-border); border-radius: 10px; background: var(--chronicle-card-surface); }
	.leaf-outcome-content, .leaf-outcome-summary { padding: 12px; border-radius: 6px; background: color-mix(in srgb, var(--chronicle-accent) 6%, var(--chronicle-card-surface)); }
	.leaf-outcome-block.is-focused .leaf-outcome-shell { border-color: color-mix(in srgb, var(--chronicle-accent) 40%, var(--chronicle-border)); }
	.leaf-result-actions { display: flex; justify-content: flex-end; }

	.leaf-outcome-summary {
		margin: 0;
		max-width: 66ch;
		font-size: var(--type-body-sm);
		line-height: 1.55;
		color: var(--chronicle-text-muted);
	}

	.leaf-outcome-content.is-compressed {
		display: none;
	}

	.warning-header {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: var(--space-lg);
	}

	.warning-title {
		margin: 0;
		font-size: var(--type-body);
		font-weight: 650;
	}

	.warning-copy,
	.leaf-outcome-empty {
		margin: 0;
		max-width: 72ch;
		font-size: var(--type-body);
		line-height: 1.6;
		color: var(--chronicle-text-muted);
	}

	.warning-title {
		color: var(--chronicle-danger-text);
	}

	.warning-shell {
		padding: var(--space-md) var(--space-lg);
		border-radius: var(--radius-md);
		border: 1px solid var(--chronicle-danger-border);
		background: var(--chronicle-danger-surface-soft);
	}

	.warning-technical {
		margin-top: 12px;
	}

	.warning-technical summary {
		cursor: pointer;
		font-size: var(--type-caption);
		font-weight: 600;
		color: var(--chronicle-text-muted);
	}

	.warning-details {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 6px 12px;
		margin: 10px 0 0;
		font-size: var(--type-caption);
		color: var(--chronicle-text-muted);
	}

	.warning-details dd {
		margin: 0;
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		color: var(--chronicle-text);
	}

	.warning-details dt {
		margin: 0;
	}

	:global(.chronicle-markdown.leaf-outcome-markdown) {
		margin-top: 0;
	}

	@media (max-width: 720px) {
		.warning-header {
			flex-direction: column;
		}
	}
</style>

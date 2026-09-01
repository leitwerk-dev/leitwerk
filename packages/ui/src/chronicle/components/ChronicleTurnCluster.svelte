<script lang="ts">
import { formatRelativeTime } from "../../lib/format";
import { markdownToPlainText, truncateText } from "../../lib/markdown.js";
import type {
	ChronicleTurnClusterItem,
	ChronicleTurnClusterSection,
} from "../lib/chronicle-projection.js";
import ChronicleExpandButton from "./ChronicleExpandButton.svelte";
import ChronicleMarkdown from "./ChronicleMarkdown.svelte";
import ChronicleSectionHeader from "./ChronicleSectionHeader.svelte";
import ChronicleThinkingSection from "./ChronicleThinkingSection.svelte";
import ChronicleTurnProgress from "./ChronicleTurnProgress.svelte";
import ChronicleUsageStats from "./ChronicleUsageStats.svelte";

interface Props {
	cluster: ChronicleTurnClusterItem;
	isFocused: boolean;
	compressHistory?: boolean;
	onOpenReasoningDetails: (turnRecordId: string) => void;
	onDraftTicket?: (artifact: { kind: "turn_result"; turnRecordId: string; text: string }) => void;
}

let {
	cluster,
	isFocused,
	compressHistory = false,
	onOpenReasoningDetails,
	onDraftTicket,
}: Props = $props();
let expandedHistoryResult = $state(false);

const shouldCompressResult = $derived(compressHistory && !expandedHistoryResult);
const clusterMeta = $derived(
	cluster.pathLabel
		? `${formatRelativeTime(cluster.createdAt)} · ${cluster.pathLabel}`
		: formatRelativeTime(cluster.createdAt),
);

function hasSections(sections: readonly ChronicleTurnClusterSection[]): boolean {
	return sections.length > 0;
}

function summarizeTurnResult(markdown: string): string {
	const plainText = markdownToPlainText(markdown);
	return plainText ? truncateText(plainText, 190) : "Result recorded.";
}

function expandHistoryResult() {
	expandedHistoryResult = true;
}
</script>

<section
	id={cluster.anchorId}
	class="turn-cluster"
	class:is-focused={isFocused}
	data-anchor-id={cluster.anchorId}
	data-focused={isFocused ? "true" : "false"}
	data-section="chronicle-turn"
	data-turn-id={cluster.turnId}
	data-turn-record-id={cluster.turnRecordId}
	data-turn-kind={cluster.turnPresentation}
>
	<div class="cluster-header">
		<div class="cluster-heading-copy">
			<ChronicleSectionHeader
				label={cluster.turnKindLabel}
				secondary={cluster.modelProfileId}
				meta={clusterMeta}
			/>
			<div class="cluster-heading-row">
				<h3>{cluster.title}</h3>
			</div>
			{#if cluster.usage}
				<div class="cluster-meta-row">
					<ChronicleUsageStats usage={cluster.usage} size="sm" showCacheIcons={false} />
				</div>
			{/if}
		</div>
	</div>

	{#if hasSections(cluster.sections)}
		<div class="cluster-body">
			{#each cluster.sections as section, index (`${cluster.turnRecordId}-${index}`)}
				{#if section.kind === "thinking_preview"}
					<ChronicleThinkingSection
						text={section.text}
						preview={section.preview}
						previewTruncated={section.previewTruncated}
						toolCallCount={section.toolCallCount}
						traceItemCount={section.traceItemCount}
						onOpenDetails={() => onOpenReasoningDetails(cluster.turnRecordId)}
					/>
				{:else if section.kind === "operator_decision"}
					{#if section.text && section.text.trim() !== cluster.title.trim()}
						<section class="content-section decision-section" data-section="operator-decision">
							<dl class="decision-fields">
								{#each section.text.split('\n\n') as block, blockIndex (`${cluster.turnRecordId}-decision-${blockIndex}-${block}`)}
									{@const parts = block.split(':\n')}
									{#if parts.length === 2}
										<div class="decision-field">
											<dt>{parts[0]}</dt>
											<dd>{parts[1]}</dd>
										</div>
									{:else}
										<div class="decision-field">
											<dd>{block}</dd>
										</div>
									{/if}
								{/each}
							</dl>
						</section>
					{/if}
				{:else if section.kind === "turn_progress"}
					<ChronicleTurnProgress report={section.report} />
				{:else if section.kind === "turn_result"}
					<section
						class="content-section result-section"
						class:is-compressed={shouldCompressResult}
						data-section="turn-result"
						data-ticket-result-artifact={`turn_result:${cluster.turnRecordId}`}
						data-ticket-result-durable="true"
						data-compressed={shouldCompressResult ? "true" : undefined}
					>
						<div class="result-header-row">
							<p class="section-label">Result</p>
							{#if onDraftTicket}
								<button
									type="button"
									class="create-issue-button"
									data-pressable="true"
									onclick={() => onDraftTicket?.({ kind: "turn_result", turnRecordId: cluster.turnRecordId, text: section.markdown })}
								>Create issue</button>
							{/if}
							{#if shouldCompressResult}
								<ChronicleExpandButton
									expanded={false}
									collapsedLabel="Expand result"
									class="expand-result-button"
									dataPressable={true}
									onClick={expandHistoryResult}
								/>
							{/if}
						</div>
						{#if shouldCompressResult}
							<p class="result-summary">{summarizeTurnResult(section.markdown)}</p>
						{:else}
							<ChronicleMarkdown markdown={section.markdown} className="turn-result-markdown" />
						{/if}
					</section>
				{/if}
			{/each}
		</div>
	{/if}
</section>

<style>
	.turn-cluster {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		padding: var(--space-lg) 0 var(--space-xl);
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
		scroll-margin-top: var(--space-xl);
	}

	.turn-cluster.is-focused {
		border-top-color: color-mix(
			in srgb,
			var(--chronicle-accent) 24%,
			var(--chronicle-border) 76%
		);
	}

	.turn-cluster[data-turn-kind="operator_decision"],
	.turn-cluster[data-turn-kind="external_trigger"] {
		padding: var(--space-lg) 0 var(--space-xl);
		margin-inline-start: var(--chronicle-secondary-indent, clamp(var(--space-lg), 4vw, var(--space-2xl)));
		border-top: 1px solid color-mix(in srgb, var(--chronicle-accent) 34%, var(--chronicle-border) 66%);
		border-bottom: 1px solid color-mix(in srgb, var(--chronicle-accent) 12%, transparent 88%);
		background: transparent;
	}

	.turn-cluster[data-turn-kind="external_trigger"] {
		border-top-color: color-mix(in srgb, var(--chronicle-attention) 38%, var(--chronicle-border) 62%);
		border-bottom-color: color-mix(in srgb, var(--chronicle-attention) 14%, transparent 86%);
	}

	.turn-cluster[data-turn-kind="operator_decision"].is-focused,
	.turn-cluster[data-turn-kind="external_trigger"].is-focused {
		border-top-color: color-mix(in srgb, var(--chronicle-accent) 52%, var(--chronicle-border) 48%);
	}

	.cluster-header {
		display: block;
	}

	.cluster-heading-copy {
		display: flex;
		flex-direction: column;
		gap: var(--space-2xs);
		min-width: 0;
	}

	.section-label {
		margin: 0;
		font-size: var(--type-label);
		font-weight: 700;
		letter-spacing: var(--tracking-label);
		text-transform: uppercase;
		color: var(--chronicle-accent);
	}

	.cluster-heading-row {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
	}

	.section-label {
		color: var(--chronicle-text-muted);
	}

	.cluster-header h3 {
		margin: 0;
		font-family: var(--font-display);
		font-size: var(--type-title-md);
		line-height: 1.18;
		letter-spacing: -0.01em;
		font-weight: 650;
		color: var(--chronicle-text);
	}

	.cluster-meta-row {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-wrap: wrap;
	}

	.cluster-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.content-section {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}

	.decision-section {
		padding: var(--space-sm) 0 0;
		border-top: 1px solid color-mix(in srgb, var(--chronicle-accent) 18%, var(--chronicle-border) 82%);
		background: transparent;
	}

	.turn-cluster[data-turn-kind="operator_decision"] .decision-section,
	.turn-cluster[data-turn-kind="external_trigger"] .decision-section {
		padding: 0;
		border: 0;
		background: transparent;
	}

	.decision-fields {
		margin: 0;
		display: grid;
		gap: var(--space-xs);
	}

	.decision-field {
		display: grid;
		gap: var(--space-2xs);
	}

	.decision-fields dt {
		margin: 0;
		font-size: var(--type-caption);
		font-weight: 600;
		color: var(--chronicle-text-muted);
	}

	.decision-fields dd {
		margin: 0;
		max-width: 66ch;
		font-size: var(--type-body);
		line-height: 1.6;
		white-space: pre-wrap;
		color: var(--chronicle-text);
	}

	.result-section {
		position: relative;
		gap: var(--space-sm);
		padding: var(--space-md) 0 0;
		border-top: 1px solid color-mix(in srgb, var(--chronicle-accent) 14%, var(--chronicle-border) 86%);
		background: transparent;
	}

	.result-section.is-compressed {
		gap: var(--space-xs);
		padding-top: var(--space-sm);
		border-top-color: color-mix(in srgb, var(--chronicle-border) 88%, white 12%);
	}

	.result-header-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
	}

	.result-section .section-label {
		color: color-mix(in srgb, var(--chronicle-text-muted) 88%, var(--chronicle-text) 12%);
	}

	.create-issue-button {
		flex: 0 0 auto;
		min-height: 36px;
		padding: 0 13px;
		border: 1px solid var(--chronicle-border-strong);
		border-radius: 999px;
		background: var(--chronicle-card-surface);
		color: var(--chronicle-text);
		font: inherit;
		font-size: var(--type-caption);
		font-weight: 700;
		cursor: pointer;
	}

	.create-issue-button:hover {
		border-color: var(--chronicle-accent);
		background: color-mix(in srgb, var(--chronicle-card-surface) 94%, var(--chronicle-accent) 6%);
		transform: translateY(-1px);
	}

	.create-issue-button:focus-visible {
		outline: 2px solid var(--chronicle-accent);
		outline-offset: 2px;
	}

	.turn-cluster.is-focused .result-section {
		border-top-color: color-mix(in srgb, var(--chronicle-accent) 34%, var(--chronicle-border) 66%);
	}

	.result-summary {
		margin: 0;
		max-width: 66ch;
		font-size: var(--type-body-sm);
		line-height: 1.55;
		color: var(--chronicle-text-muted);
	}

	:global(.chronicle-markdown.turn-result-markdown) {
		margin-top: 0;
		max-width: 70ch;
	}

	@media (max-width: 720px) {
		.turn-cluster[data-turn-kind="operator_decision"],
		.turn-cluster[data-turn-kind="external_trigger"] {
			margin-inline-start: 0;
		}

		.cluster-header {
			flex-direction: column;
		}

		.result-header-row {
			align-items: start;
			flex-wrap: wrap;
		}
	}
</style>

<script lang="ts">
import type { ProcessQuestionRequest } from "@leitwerk-dev/domain";
import type { Snippet } from "svelte";
import { markdownToPlainText, truncateText } from "../../lib/markdown.js";
import type { ChronicleTurnClusterItem } from "../lib/chronicle-projection.js";
import type { ChronicleTicketArtifact } from "../lib/chronicle-ticket-artifact.js";
import { formatChronicleCost, formatChronicleDuration } from "../lib/formatting.js";
import ChronicleCreateIssueButton from "./ChronicleCreateIssueButton.svelte";
import ChronicleEntryHeader from "./ChronicleEntryHeader.svelte";
import ChronicleExpandButton from "./ChronicleExpandButton.svelte";
import ChronicleFailureMessage from "./ChronicleFailureMessage.svelte";
import ChronicleMarkdown from "./ChronicleMarkdown.svelte";
import ChronicleThinkingSection from "./ChronicleThinkingSection.svelte";
import ChronicleTurnDetailsButton from "./ChronicleTurnDetailsButton.svelte";
import ChronicleTurnProgress from "./ChronicleTurnProgress.svelte";

interface Props {
	cluster: ChronicleTurnClusterItem;
	isFocused: boolean;
	compressHistory?: boolean;
	questionRequests?: readonly ProcessQuestionRequest[];
	onOpenReasoningDetails: (turnRecordId: string) => void;
	onDraftTicket?: (artifact: ChronicleTicketArtifact) => void;
	recoveryContent?: Snippet;
	waitingContent?: Snippet;
}

let {
	cluster,
	isFocused,
	compressHistory = false,
	questionRequests = [],
	onOpenReasoningDetails,
	onDraftTicket,
	recoveryContent,
	waitingContent,
}: Props = $props();
let resultExpanded = $state<boolean | null>(null);
let failureExpanded = $state(true);
const isFailed = $derived(Boolean(cluster.failure || recoveryContent));
const isLlm = $derived(cluster.turnPresentation === "llm_turn");
const result = $derived(cluster.sections.find((section) => section.kind === "turn_result"));
const reasoning = $derived(cluster.sections.find((section) => section.kind === "thinking_preview"));
const hasReasoning = $derived(
	Boolean(
		reasoning &&
			(reasoning.text.trim() ||
				reasoning.preview.trim() ||
				reasoning.toolCallCount ||
				reasoning.traceItemCount),
	),
);
const progress = $derived(cluster.sections.find((section) => section.kind === "turn_progress"));
const prompt = $derived(isLlm ? cluster.piInput?.fullPrompt.trim() : null);
const compactResult = $derived(
	Boolean(
		result &&
			compressHistory &&
			!prompt &&
			result.markdown.length <= 240 &&
			!/[\n]|^\s*(?:#|[-*>]|\d+\.)/.test(result.markdown),
	),
);
const expanded = $derived(resultExpanded ?? !compressHistory);
const metadata = $derived(
	[
		cluster.modelProfileId,
		cluster.usage?.cost ? formatChronicleCost(cluster.usage.cost.total) : null,
	]
		.filter(Boolean)
		.join(" · "),
);
const kind = $derived(
	isLlm
		? "llm"
		: cluster.turnPresentation === "operator_decision"
			? "operator"
			: cluster.turnPresentation === "external_trigger"
				? "external"
				: "system",
);

function openDetails() {
	onOpenReasoningDetails(cluster.turnRecordId);
}
</script>

<section
	id={cluster.anchorId}
	class="turn-cluster"
	class:is-focused={isFocused}
	class:is-compact={!isLlm || compactResult}
	class:is-failed={isFailed}
	data-anchor-id={cluster.anchorId}
	data-focused={isFocused ? "true" : "false"}
	data-section="chronicle-turn"
	data-turn-id={cluster.turnId}
	data-turn-record-id={cluster.turnRecordId}
	data-turn-kind={cluster.turnPresentation}
>
	<ChronicleEntryHeader title={cluster.title} {kind} failed={isFailed} metadata={metadata || null} timestamp={cluster.createdAt} duration={formatChronicleDuration(cluster.facts.startedAt, cluster.facts.endedAt)}>
		{#snippet controls()}
			{#if isFailed}
				<button class="failure-toggle" type="button" data-action="toggle-failed-turn" aria-label={failureExpanded ? "Collapse failed turn" : "Expand failed turn"} aria-expanded={failureExpanded} aria-controls={`turn-body-${cluster.turnRecordId}`} onclick={() => failureExpanded = !failureExpanded}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d={failureExpanded ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>
				</button>
			{/if}
		{/snippet}
	</ChronicleEntryHeader>

	{#if isFailed && !failureExpanded}<p class="collapsed-failure">Failed</p>{/if}
	<div class="turn-body" id={`turn-body-${cluster.turnRecordId}`} hidden={isFailed && !failureExpanded}>
	{#if prompt}
		<button class="prompt-row" type="button" data-section="turn-prompt" aria-label={`View prompt for ${cluster.title}`} onclick={openDetails}>
			<span class="prompt-label">Prompt</span>
			<span class="prompt-preview">{truncateText(markdownToPlainText(prompt), 240)}</span>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
		</button>
	{/if}

	{#each cluster.sections as section, index (`${cluster.turnRecordId}-${index}`)}
		{#if !isFailed && section.kind === "operator_decision" && section.text && section.text.trim() !== cluster.title.trim()}
			<div class="decision-section" data-section="operator-decision">
				<dl class="decision-fields">
					{#each section.text.split('\n\n') as block, blockIndex (`${blockIndex}-${block}`)}
						{@const parts = block.split(':\n')}
						<div class="decision-field">
							{#if parts.length === 2}<dt>{parts[0]}</dt><dd>{parts[1]}</dd>{:else}<dd>{block}</dd>{/if}
						</div>
					{/each}
				</dl>
			</div>
		{/if}
	{/each}

	{#if progress && !isLlm}<ChronicleTurnProgress report={progress.report} />{/if}

	{#if result}
		<section class="result-section" class:is-compact={compactResult} class:is-compressed={!expanded && !compactResult} data-section="turn-result" data-ticket-result-artifact={`turn_result:${cluster.turnRecordId}`} data-ticket-result-durable="true" data-compressed={!expanded && !compactResult ? "true" : undefined}>
			{#if !compactResult}
				<div class="result-header-row">
					<h4>Result</h4>
					<div class="result-actions">
						{#if onDraftTicket}<ChronicleCreateIssueButton {onDraftTicket} artifact={{ kind: "turn_result", turnRecordId: cluster.turnRecordId }} />{/if}
						<ChronicleExpandButton expanded={expanded} controls={`result-${cluster.turnRecordId}`} expandedLabel="Collapse result" collapsedLabel="Expand result" onClick={() => resultExpanded = !expanded} />
					</div>
				</div>
			{/if}
			<div id={`result-${cluster.turnRecordId}`}>
			{#if expanded || compactResult}
				<ChronicleMarkdown markdown={result.markdown} className="turn-result-markdown" />
			{:else}
				<p class="result-summary">{truncateText(markdownToPlainText(result.markdown), 190)}</p>
			{/if}
			</div>
		</section>
	{/if}

	{#if recoveryContent}
		{@render recoveryContent()}
	{:else if cluster.failure}
		<ChronicleFailureMessage summary={cluster.failure.summary} />
	{/if}

	{#if questionRequests.length}
		<ChronicleThinkingSection text="" preview="" traceItemCount={0} {questionRequests} />
	{/if}

	{@render waitingContent?.()}

	{#if isLlm || hasReasoning || (compactResult && onDraftTicket)}
		<div class="cluster-support" class:has-reasoning={hasReasoning}>
			<div class="support-progress">{#if progress && isLlm}<ChronicleTurnProgress report={progress.report} compact />{/if}</div>
			<div class="footer-actions">
				{#if compactResult && onDraftTicket}<ChronicleCreateIssueButton {onDraftTicket} artifact={{ kind: "turn_result", turnRecordId: cluster.turnRecordId }} />{/if}
				{#if isLlm || hasReasoning}
					<div class="turn-info-actions">
						{#if hasReasoning}<ChronicleExpandButton expanded={false} collapsedLabel="Expand reasoning" dataAction="open-reasoning-details" ariaLabel="Expand reasoning" onClick={openDetails} />{/if}
						{#if isLlm}<ChronicleTurnDetailsButton title={cluster.title} onClick={openDetails} />{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	</div>
</section>

<style>
	.turn-cluster { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--chronicle-border); border-radius: 10px; background: var(--chronicle-card-surface); scroll-margin-top: var(--space-sm); }
	.turn-cluster.is-focused { border-color: color-mix(in srgb, var(--chronicle-accent) 40%, var(--chronicle-border)); }
	.turn-cluster.is-failed { border-color: color-mix(in srgb, var(--chronicle-danger) 50%, var(--chronicle-border)); background: color-mix(in srgb, var(--chronicle-danger) 2%, var(--chronicle-card-surface)); }
	.turn-body { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
	.turn-body[hidden], .turn-body:empty { display: none; }
	.failure-toggle { display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 4px; background: transparent; color: var(--chronicle-text-muted); cursor: pointer; }
	.failure-toggle:hover { background: var(--chronicle-panel-muted); }
	.failure-toggle:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 2px; }
	.collapsed-failure { margin: 0; padding-left: 42px; color: var(--chronicle-danger-text); font-size: var(--type-body-sm); }
	.turn-cluster.is-compact { gap: 6px; }
	.turn-cluster[data-turn-kind="operator_decision"], .turn-cluster[data-turn-kind="external_trigger"], .turn-cluster[data-turn-kind="automatic_turn"] { background: var(--chronicle-card-surface-strong); padding-block: 10px; }
	.prompt-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; width: 100%; min-height: 36px; padding: 7px 10px; border: 0; border-radius: 5px; background: var(--chronicle-panel-muted); text-align: left; color: var(--chronicle-text-muted); font: inherit; font-size: var(--type-body-sm); cursor: pointer; }
	.prompt-row:hover { background: color-mix(in srgb, var(--chronicle-panel-muted) 90%, var(--chronicle-accent)); }
	.prompt-row:focus-visible { outline: 2px solid var(--chronicle-accent); outline-offset: 2px; }
	.prompt-label { font-weight: 600; }
	.prompt-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.result-section { display: grid; gap: 6px; padding: 10px 12px; border-radius: 6px; background: color-mix(in srgb, var(--chronicle-accent) 6%, var(--chronicle-card-surface)); }
	.result-section.is-compact { padding: 0 0 0 42px; background: transparent; }
	.result-header-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.result-header-row h4 { margin: 0; font-size: var(--type-body); font-weight: 700; color: var(--chronicle-text); }
	.result-summary { margin: 0; font-size: var(--type-body); line-height: 1.55; color: var(--chronicle-text); overflow-wrap: anywhere; }
	.result-actions { display: flex; align-items: center; justify-content: flex-end; gap: 14px; }
	.cluster-support { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 12px; min-width: 0; color: var(--chronicle-text-muted); }
	.support-progress { min-width: 0; }
	.footer-actions { display: flex; align-items: center; gap: 14px; }
	.turn-info-actions { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
	.decision-section { padding-inline-start: 42px; color: var(--chronicle-text-muted); font-size: var(--type-body-sm); line-height: 1.5; }
	.decision-fields { display: grid; gap: 6px; margin: 0; }
	.decision-field { display: flex; flex-wrap: wrap; gap: 4px 8px; }
	dt { font-weight: 600; }
	dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
	@media (max-width: 540px) {
		.turn-cluster { padding: 10px; }
		.result-section { padding: 8px 10px; }
		.result-section.is-compact, .decision-section { padding-inline-start: 32px; }
		.cluster-support.has-reasoning { grid-template-columns: minmax(0, 1fr); gap: 6px; }
		.has-reasoning .footer-actions { grid-row: 1; justify-content: flex-end; flex-wrap: wrap; }
		.has-reasoning .support-progress { grid-row: 2; }
		.has-reasoning .support-progress:empty { display: none; }
	}
</style>

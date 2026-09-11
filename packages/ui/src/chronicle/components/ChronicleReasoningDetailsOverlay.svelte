<script lang="ts">
import type { ProcessQuestionRequest } from "@leitwerk-dev/domain";
import { onDestroy, onMount, tick } from "svelte";
import type { ToolCallRendererDefinition } from "../../lib/api";
import type {
	ChronicleReasoningDetailEntry,
	ChronicleRunMode,
	ChronicleTriggerSource,
} from "../lib/chronicle-projection.js";
import { normalizeChronicleText } from "../lib/formatting.js";
import { buildPromptHighlightSegments } from "../lib/prompt-highlighting.js";
import ChronicleLiveChip from "./ChronicleLiveChip.svelte";
import ChronicleQuestionRequest from "./ChronicleQuestionRequest.svelte";
import ChronicleThinkingText from "./ChronicleThinkingText.svelte";
import ChronicleToolCallItem from "./ChronicleToolCallItem.svelte";
import ChronicleUsageStats from "./ChronicleUsageStats.svelte";

interface Props {
	entry: ChronicleReasoningDetailEntry;
	toolRendererIndex: Record<string, ToolCallRendererDefinition>;
	questionRequests?: readonly ProcessQuestionRequest[];
	hasPrevious: boolean;
	hasNext: boolean;
	onClose: () => void;
	onPrevious: () => void;
	onNext: () => void;
}

let {
	entry,
	toolRendererIndex,
	questionRequests = [],
	hasPrevious,
	hasNext,
	onClose,
	onPrevious,
	onNext,
}: Props = $props();
let closeButton: HTMLButtonElement | null = $state(null);
let panelElement: HTMLDivElement | null = $state(null);
let shouldFollowLiveTimeline = $state(true);
let copyState = $state<"idle" | "copied" | "failed">("idle");
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
let copiedEntryId = $state<string | null>(null);

function isNearPanelBottom(element: HTMLElement, thresholdPx = 32): boolean {
	return element.scrollHeight - element.clientHeight - element.scrollTop <= thresholdPx;
}

function handlePanelScroll() {
	if (!panelElement) {
		return;
	}
	shouldFollowLiveTimeline = isNearPanelBottom(panelElement);
}

async function copyText(value: string): Promise<void> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(value);
		return;
	}

	if (typeof document === "undefined") {
		throw new Error("Clipboard unavailable");
	}

	const textArea = document.createElement("textarea");
	textArea.value = value;
	textArea.setAttribute("readonly", "true");
	textArea.style.position = "fixed";
	textArea.style.opacity = "0";
	textArea.style.pointerEvents = "none";
	document.body.appendChild(textArea);
	textArea.select();
	const copied = typeof document.execCommand === "function" && document.execCommand("copy");
	document.body.removeChild(textArea);
	if (!copied) {
		throw new Error("Clipboard unavailable");
	}
}

function copyablePiInputText(piInput: ChronicleReasoningDetailEntry["piInput"]): string {
	if (!piInput) {
		return "";
	}
	if (piInput.parts.length === 1) {
		return piInput.parts[0]?.text ?? "";
	}
	return piInput.fullPrompt;
}

function piInputPartLabel(
	part: NonNullable<ChronicleReasoningDetailEntry["piInput"]>["parts"][number],
	index: number,
	total: number,
): string {
	const baseLabel = part.role === "system" ? "Pi system message" : "Pi input message";
	return total > 1 ? `${baseLabel} ${index + 1}` : baseLabel;
}

async function handleCopyPrompt() {
	if (!entry.piInput) {
		return;
	}
	try {
		await copyText(copyablePiInputText(entry.piInput));
		copyState = "copied";
		copiedEntryId = entry.turnRecordId;
	} catch {
		copyState = "failed";
		copiedEntryId = entry.turnRecordId;
	}
	if (copyResetTimer) {
		clearTimeout(copyResetTimer);
	}
	copyResetTimer = setTimeout(() => {
		copyState = "idle";
		copyResetTimer = null;
		copiedEntryId = null;
	}, 1800);
}

function handleWindowKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
		return;
	}
	if (event.key === "Escape") {
		event.preventDefault();
		onClose();
		return;
	}
	if (event.key === "ArrowLeft" && hasPrevious) {
		event.preventDefault();
		onPrevious();
		return;
	}
	if (event.key === "ArrowRight" && hasNext) {
		event.preventDefault();
		onNext();
	}
}

function parseTimestamp(value: string | null): number | null {
	if (!value) {
		return null;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function formatDurationLabel(startedAt: string | null, endedAt: string | null): string {
	const start = parseTimestamp(startedAt);
	const end = parseTimestamp(endedAt);
	if (start === null || end === null || end < start) {
		return "Unknown";
	}
	const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
	if (totalSeconds < 1) {
		return "<1s";
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) {
		parts.push(`${hours}h`);
	}
	if (minutes > 0) {
		parts.push(`${minutes}m`);
	}
	if (seconds > 0 || parts.length === 0) {
		parts.push(`${seconds}s`);
	}
	return parts.join(" ");
}

function triggerSourceLabel(value: ChronicleTriggerSource): string {
	switch (value) {
		case "external_event":
			return "External event";
		case "user_action":
			return "User action";
		default:
			return "Unknown";
	}
}

function runModeLabel(value: ChronicleRunMode): string {
	switch (value) {
		case "scheduled":
			return "Scheduled";
		case "immediate":
			return "Run immediately";
		default:
			return "Unknown";
	}
}

function isQuietFactValue(value: string): boolean {
	return value === "Unknown" || value === "None";
}

function operationalSeverityLabel(severity: string): string {
	switch (severity) {
		case "success":
			return "Recovered";
		case "warning":
			return "Attention";
		case "error":
			return "Error";
		default:
			return "Info";
	}
}

const fullPrompt = $derived(entry.piInput?.fullPrompt ?? "");
const promptParts = $derived.by(() => {
	const parts = entry.piInput?.parts ?? [];
	if (parts.length > 0) {
		return parts;
	}
	if (entry.piInput && fullPrompt.trim() !== "") {
		return [
			{
				entryId: `${entry.turnRecordId}:pi-input`,
				role: "unknown" as const,
				text: fullPrompt,
				createdAt: entry.piInput.createdAt,
			},
		];
	}
	return [];
});
const hasPrompt = $derived(promptParts.some((part) => part.text.trim() !== ""));
const promptHighlight = $derived.by(() =>
	buildPromptHighlightSegments({
		fullPrompt,
		userInput: entry.piInput?.userInput ?? null,
	}),
);
const promptDisplayParts = $derived.by(() =>
	promptParts.map((part, index) => ({
		part,
		label: piInputPartLabel(part, index, promptParts.length),
		highlight: buildPromptHighlightSegments({
			fullPrompt: part.text,
			userInput: entry.piInput?.userInput ?? null,
		}),
	})),
);
const showPromptMatchNote = $derived(hasPrompt && promptHighlight.matchState === "not_found");
const normalizedReasoning = $derived(normalizeChronicleText(entry.reasoningSection.text));
const liveStatusLabel = $derived(entry.isLive ? (entry.stateLabel ?? "Live") : null);
const copyButtonLabel = $derived(
	copyState === "copied" && copiedEntryId === entry.turnRecordId
		? "Copied"
		: copyState === "failed" && copiedEntryId === entry.turnRecordId
			? "Copy failed"
			: "Copy prompt",
);
const modelLabel = $derived(entry.modelProfileId ?? "Unknown model");
const durationLabel = $derived(formatDurationLabel(entry.facts.startedAt, entry.facts.endedAt));
const triggerLabel = $derived(triggerSourceLabel(entry.facts.triggerSource));
const runLabel = $derived(runModeLabel(entry.facts.runMode));
const activeToolsLabel = $derived(
	entry.facts.activeToolNames.length > 0 ? entry.facts.activeToolNames.join(", ") : "None",
);
const unmatchedQuestionRequests = $derived(
	questionRequests.filter(
		(request) =>
			!entry.reasoningSection.items.some(
				(item) => item.kind === "tool_call" && item.toolCall.toolCallId === request.toolCallId,
			),
	),
);

function questionsForTool(toolCallId: string): readonly ProcessQuestionRequest[] {
	return questionRequests.filter((request) => request.toolCallId === toolCallId);
}

$effect(() => {
	if (!panelElement || !shouldFollowLiveTimeline) {
		return;
	}

	entry.reasoningSection.items.length;
	normalizedReasoning;

	void tick().then(() => {
		if (!panelElement || !shouldFollowLiveTimeline) {
			return;
		}
		panelElement.scrollTop = panelElement.scrollHeight;
	});
});

onMount(() => {
	void tick().then(() => closeButton?.focus({ preventScroll: true }));
	window.addEventListener("keydown", handleWindowKeydown);
});

onDestroy(() => {
	window.removeEventListener("keydown", handleWindowKeydown);
	if (copyResetTimer) {
		clearTimeout(copyResetTimer);
	}
});
</script>

<div
	bind:this={panelElement}
	class="reasoning-details-overlay"
	data-section="reasoning-details-overlay"
	role="dialog"
	aria-modal="false"
	aria-labelledby={`reasoning-details-title-${entry.turnRecordId}`}
	onscroll={handlePanelScroll}
>
		<header class="overlay-header">
			<div class="overlay-header-copy">
				<h2 id={`reasoning-details-title-${entry.turnRecordId}`}>Reasoning details</h2>
				<div class="overlay-title-row">
					<p class="overlay-turn-title">{entry.title}</p>
					{#if liveStatusLabel}
						<ChronicleLiveChip label={liveStatusLabel} size="md" />
					{/if}
				</div>
			</div>

			<div class="overlay-header-actions">
				<div class="nav-group" aria-label="Reasoning turn navigation">
					<button
						type="button"
						class="ui-button nav-button" data-size="icon"
						data-action="reasoning-overlay-prev"
						onclick={onPrevious}
						disabled={!hasPrevious}
						aria-label="Previous reasoning turn"
					>
						<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m12 4-6 6 6 6" /></svg>
					</button>
					<button
						type="button"
						class="ui-button nav-button" data-size="icon"
						data-action="reasoning-overlay-next"
						onclick={onNext}
						disabled={!hasNext}
						aria-label="Next reasoning turn"
					>
						<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m8 4 6 6-6 6" /></svg>
					</button>
				</div>
				<button
					bind:this={closeButton}
					type="button"
					class="ui-button close-button"
					data-action="close-reasoning-overlay"
					onclick={() => onClose()}
					aria-label="Close reasoning details"
				>
					Close
				</button>
			</div>
		</header>

		<div class="overlay-body">
			<div class="run-summary-line" data-section="reasoning-run-summary">
				<span class="model-name">{modelLabel}</span>
				{#if entry.usage}
					<ChronicleUsageStats usage={entry.usage} size="md" />
				{:else}
					<span class="summary-muted">Usage unavailable</span>
				{/if}
			</div>

			<dl class="turn-facts" data-section="reasoning-turn-facts">
				<div class="fact-row">
					<dt>Duration</dt>
					<dd class={["fact-value", isQuietFactValue(durationLabel) && "is-muted"]}>
						{durationLabel}
					</dd>
				</div>
				<div class="fact-row">
					<dt>Triggered by</dt>
					<dd class={["fact-value", isQuietFactValue(triggerLabel) && "is-muted"]}>
						{triggerLabel}
					</dd>
				</div>
				<div class="fact-row">
					<dt>Run mode</dt>
					<dd class={["fact-value", isQuietFactValue(runLabel) && "is-muted"]}>{runLabel}</dd>
				</div>
				<div class="fact-row">
					<dt>Active tools</dt>
					<dd class={["fact-value", isQuietFactValue(activeToolsLabel) && "is-muted"]}>
						{activeToolsLabel}
					</dd>
				</div>
			</dl>

			<section class="overlay-section prompt-section" data-section="reasoning-overlay-pi-input">
				<div class="section-header-row">
					<div class="section-heading">
						<p class="section-label">Pi input</p>
						<p class="section-caption">
							Actual input message entries recorded in Pi's session tree. User input is
							highlighted when matched.
						</p>
					</div>
					{#if hasPrompt}
						<button
							type="button"
							class="ui-button copy-button"
							data-action="copy-pi-input"
							onclick={handleCopyPrompt}
						>
							{copyButtonLabel}
						</button>
					{/if}
				</div>

				{#if hasPrompt}
					<div class="prompt-part-list" data-prompt-part-count={promptDisplayParts.length}>
						{#each promptDisplayParts as displayPart (displayPart.part.entryId)}
							<article
								class={["prompt-part", promptDisplayParts.length === 1 && "is-single"]}
								data-section="pi-input-message"
							>
								{#if promptDisplayParts.length > 1}
									<div class="prompt-part-header">
										<p class="prompt-part-label">{displayPart.label}</p>
										<p class="prompt-part-meta">{displayPart.part.createdAt}</p>
									</div>
								{/if}
								<pre class="prompt-copy" data-match-state={displayPart.highlight.matchState}>{#each displayPart.highlight.segments as segment (`${displayPart.part.entryId}-${segment.start}-${segment.end}-${segment.kind}`)}<span
										class="prompt-segment"
										data-kind={segment.kind}
										data-highlight={segment.kind === "user_input" ? "user-input" : undefined}
									>{segment.text}</span>{/each}</pre>
							</article>
						{/each}
					</div>
					{#if showPromptMatchNote}
						<p class="diagnostic-note" data-section="prompt-match-note">
							User input could not be matched inside the recorded Pi prompt.
						</p>
					{/if}
				{:else}
					<p class="empty-copy">No Pi input was recorded for this turn.</p>
				{/if}
			</section>

			<section class="overlay-section reasoning-section" data-section="reasoning-overlay-trace">
				<div class="section-heading">
					<p class="section-label">Reasoning details</p>
					<p class="section-caption">Thinking, tool calls, retries, errors, and compactions in execution order.</p>
				</div>

				<div class="reasoning-timeline" data-live={entry.isLive ? "true" : "false"}>
					{#if entry.reasoningSection.items.length > 0}
						{#each entry.reasoningSection.items as item, index (`reasoning-${entry.turnRecordId}-${index}`)}
							{#if item.kind === "thinking_chunk"}
								<ChronicleThinkingText text={item.text} />
							{:else if item.kind === "tool_call"}
								<ChronicleToolCallItem toolCall={item.toolCall} {toolRendererIndex} />
								{#each questionsForTool(item.toolCall.toolCallId) as request (request.id)}
									<div class="trace-question" data-tool-call-id={request.toolCallId}>
										<ChronicleQuestionRequest {request} mode="trace" />
									</div>
								{/each}
							{:else}
								<div
									class="operational-event"
									data-section="reasoning-operational-event"
									data-event-type={item.event.eventType}
									data-severity={item.event.severity}
								>
									<div class="operational-event-header">
										<span class="operational-event-severity">{operationalSeverityLabel(item.event.severity)}</span>
										<span class="operational-event-title">{item.event.title}</span>
									</div>
									<p>{item.event.message}</p>
								</div>
							{/if}
						{/each}
					{:else if normalizedReasoning}
						<ChronicleThinkingText text={normalizedReasoning} />
					{:else if unmatchedQuestionRequests.length === 0}
						<p class="empty-copy">No reasoning details were recorded for this turn.</p>
					{/if}
					{#each unmatchedQuestionRequests as request (request.id)}
						<div class="trace-question" data-tool-call-id={request.toolCallId}>
							<ChronicleQuestionRequest {request} mode="trace" />
						</div>
					{/each}
				</div>
			</section>
		</div>
</div>

<style>
	.reasoning-details-overlay {
		display: grid;
		height: 100%;
		min-height: 0;
		border-radius: var(--radius-lg);
		border: 1px solid color-mix(in srgb, var(--chronicle-border-strong) 72%, white 28%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 98%, white 2%);
		box-shadow: 0 20px 56px rgba(15, 23, 42, 0.18);
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
	}

	.overlay-header {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		justify-content: space-between;
		gap: 18px;
		align-items: start;
		padding: var(--space-lg);
		border-bottom: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 92%, white 8%);
	}

	.overlay-header-copy {
		display: grid;
		gap: 8px;
		min-width: 0;
	}

	.section-label,
	.section-caption,
	.turn-facts,
	.turn-facts dd {
		margin: 0;
	}

	.section-label {
		font-size: var(--type-label);
		font-weight: 700;
		letter-spacing: var(--tracking-label);
		text-transform: uppercase;
		color: var(--chronicle-text-muted);
	}

	.section-caption {
		font-size: var(--type-caption);
		line-height: 1.5;
		color: var(--chronicle-text-muted);
	}

	.overlay-title-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
	}

	.overlay-header-copy h2 { margin: 0; font-size: var(--type-title-md); line-height: 1.2; font-weight: 680; }
	.overlay-turn-title { margin: 0; font-size: var(--type-body-sm); line-height: 1.5; color: var(--chronicle-text-muted); }

	.overlay-header-actions,
	.nav-group,
	.section-header-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.overlay-header-actions {
		flex-shrink: 0;
	}

	.overlay-body {
		display: grid;
		min-width: 0;
		overflow-wrap: anywhere;
		gap: 24px;
		padding: 18px 28px 30px;
	}

	.run-summary-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		padding-bottom: 14px;
		border-bottom: 1px solid color-mix(in srgb, var(--chronicle-border) 70%, transparent 30%);
		font-variant-numeric: tabular-nums;
	}

	.model-name {
		font-size: var(--type-body-sm);
		font-weight: 700;
		color: var(--chronicle-text);
	}

	.summary-muted {
		font-size: 12px;
		color: var(--chronicle-text-muted);
	}

	.turn-facts {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 14px 18px;
		padding-bottom: 4px;
	}

	.fact-row {
		display: grid;
		align-content: start;
		gap: 4px;
		min-width: 0;
	}

	.fact-row dt {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--chronicle-text-muted);
	}

	.fact-value {
		font-size: var(--type-body-sm);
		line-height: 1.4;
		font-weight: 620;
		color: var(--chronicle-text);
		word-break: break-word;
	}

	.fact-value.is-muted {
		font-weight: 520;
		color: var(--chronicle-text-muted);
	}

	.overlay-section {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-width: 0;
		gap: 12px;
	}

	.section-heading {
		display: grid;
		gap: 4px;
	}

	.section-header-row {
		justify-content: space-between;
		align-items: start;
	}

	.prompt-section {
		padding-top: 2px;
	}

	.prompt-copy,
	.empty-copy,
	.diagnostic-note {
		margin: 0;
		font-size: var(--type-body-sm);
		line-height: 1.72;
	}

	.prompt-part-list {
		display: grid;
		gap: 12px;
	}

	.prompt-part {
		display: grid;
		gap: 8px;
	}

	.prompt-part-header {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px 14px;
	}

	.prompt-part-label,
	.prompt-part-meta {
		margin: 0;
		font-size: var(--type-caption);
		line-height: 1.4;
	}

	.prompt-part-label {
		font-weight: 700;
		color: var(--chronicle-text);
	}

	.prompt-part-meta {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
		color: var(--chronicle-text-muted);
	}

	.prompt-copy {
		max-width: 100%;
		padding: 16px 18px;
		border-radius: 18px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
		background: color-mix(in srgb, var(--chronicle-panel-muted) 74%, white 26%);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--chronicle-text-muted);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
		font-size: 12px;
	}

	.prompt-segment[data-kind="context"] {
		color: var(--chronicle-text-muted);
	}

	.prompt-segment[data-kind="user_input"] {
		border-radius: 6px;
		padding: 1px 3px;
		background: color-mix(in srgb, var(--chronicle-accent-soft) 72%, white 28%);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--chronicle-accent) 24%, transparent 76%);
		color: var(--chronicle-text);
		font-weight: 650;
	}

	.empty-copy,
	.diagnostic-note {
		color: var(--chronicle-text-muted);
	}

	.diagnostic-note {
		font-size: var(--type-caption);
	}

	.reasoning-section {
		padding-top: 20px;
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 78%, transparent 22%);
	}

	.reasoning-timeline {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding-right: 0;
	}

	.reasoning-timeline > :global(*) {
		flex: 0 0 auto;
		min-width: 0;
	}

	.trace-question {
		padding: 14px;
		border-radius: 14px;
		border: 1px solid color-mix(in srgb, var(--chronicle-accent) 22%, var(--chronicle-border) 78%);
		background: color-mix(in srgb, var(--chronicle-accent-soft) 18%, white 82%);
	}

	.operational-event {
		display: grid;
		gap: 8px;
		padding: 12px 14px;
		border-radius: 14px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
		background: color-mix(in srgb, var(--chronicle-panel-muted) 80%, white 20%);
	}

	.operational-event[data-severity="error"] {
		border-color: var(--chronicle-danger-border);
		background: var(--chronicle-danger-surface-soft);
	}

	.operational-event[data-severity="warning"] {
		border-color: color-mix(in srgb, var(--chronicle-attention) 38%, var(--chronicle-border));
		background: color-mix(in srgb, var(--chronicle-attention) 7%, var(--chronicle-card-surface));
	}

	.operational-event[data-severity="success"] {
		border-color: color-mix(in srgb, var(--chronicle-success) 38%, var(--chronicle-border));
		background: var(--chronicle-success-surface);
	}

	.operational-event-header {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.operational-event-severity {
		padding: 3px 7px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--chronicle-card-surface) 86%, white 14%);
		color: var(--chronicle-text-muted);
		font-size: var(--type-caption);
		font-weight: 800;
		letter-spacing: var(--tracking-label);
		text-transform: uppercase;
	}

	.operational-event-title {
		font-weight: 800;
		color: var(--chronicle-text-strong);
	}

	.operational-event p {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--chronicle-text);
		font-size: var(--type-body-sm);
		line-height: 1.55;
	}

	@media (max-width: 980px) {
		.turn-facts {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 900px) {
		.overlay-header,
		.overlay-body {
			padding-left: 18px;
			padding-right: 18px;
		}
	}

	@media (max-width: 720px) {
		.overlay-header,
		.section-header-row {
			flex-direction: column;
			align-items: stretch;
		}

		.overlay-header-actions {
			width: 100%;
			justify-content: space-between;
		}

		.turn-facts {
			grid-template-columns: minmax(0, 1fr);
		}

		.copy-button {
			width: 100%;
		}
	}

</style>

<script lang="ts">
import type { ProcessDetailData } from "../../lib/api";
import type { ChronicleSelectableItem } from "../lib/chronicle-selectable-items.js";

interface Props {
	detail: ProcessDetailData | null;
	loading: boolean;
	error: string | null;
	railItems: readonly ChronicleSelectableItem[];
	activeAnchorId: string | null;
	onSelectAnchor: (anchorId: string) => void;
}

let { detail, loading, error, railItems, activeAnchorId, onSelectAnchor }: Props = $props();
let railListElement = $state<HTMLDivElement | null>(null);

$effect(() => {
	const listElement = railListElement;
	if (!listElement || !activeAnchorId) {
		return;
	}
	queueMicrotask(() => {
		const activeItem = [...listElement.querySelectorAll<HTMLElement>("[data-rail-anchor-id]")].find(
			(element) => element.dataset.railAnchorId === activeAnchorId,
		);
		activeItem?.scrollIntoView?.({ block: "nearest", inline: "center" });
	});
});

function focusRailButton(index: number) {
	queueMicrotask(() => {
		const button =
			railListElement?.querySelectorAll<HTMLButtonElement>("[data-rail-anchor-id]")[index];
		button?.focus();
	});
}

function selectRailItem(index: number) {
	const item = railItems[index];
	if (!item) {
		return;
	}
	onSelectAnchor(item.anchorId);
	focusRailButton(index);
}

function handleRailKeydown(event: KeyboardEvent, index: number) {
	if (railItems.length === 0) {
		return;
	}

	let nextIndex: number | null = null;
	switch (event.key) {
		case "ArrowDown":
		case "ArrowRight":
			nextIndex = Math.min(index + 1, railItems.length - 1);
			break;
		case "ArrowUp":
		case "ArrowLeft":
			nextIndex = Math.max(index - 1, 0);
			break;
		case "Home":
			nextIndex = 0;
			break;
		case "End":
			nextIndex = railItems.length - 1;
			break;
		default:
			return;
	}

	if (nextIndex === null) {
		return;
	}

	event.preventDefault();
	event.stopPropagation();
	selectRailItem(nextIndex);
}

function markerShape(item: ChronicleSelectableItem): string {
	if (item.kind === "turn") {
		return item.shape;
	}
	return item.hierarchy === "secondary" ? "pill" : "circle";
}

function itemTurnRecordId(item: ChronicleSelectableItem): string | undefined {
	return item.kind === "turn" ? item.turnRecordId : undefined;
}

function itemTurnId(item: ChronicleSelectableItem): string | undefined {
	return item.kind === "turn" ? item.turnId : undefined;
}

function itemSection(item: ChronicleSelectableItem): string | undefined {
	switch (item.kind) {
		case "action":
			return "action-required-indicator";
		case "terminal":
			return "terminal-state-indicator";
		default:
			return undefined;
	}
}

function itemTerminalStatus(item: ChronicleSelectableItem): string | undefined {
	return item.kind === "terminal" ? item.terminalStatus : undefined;
}

function showRailDetail(item: ChronicleSelectableItem): boolean {
	return item.kind === "action" && Boolean(item.detail);
}

function compactRailItem(item: ChronicleSelectableItem): boolean {
	return !showRailDetail(item);
}

function itemAriaLabel(item: ChronicleSelectableItem): string | undefined {
	const hiddenParts: string[] = [];
	if (item.label !== item.title) {
		hiddenParts.push(item.label);
	}
	if (!showRailDetail(item) && item.detail) {
		hiddenParts.push(item.detail);
	}
	return hiddenParts.length > 0 ? `${item.title} — ${hiddenParts.join(" · ")}` : undefined;
}
</script>

<section class="turn-rail" data-column="turn-rail" aria-labelledby="process-navigation-heading">
	<h2 id="process-navigation-heading" class="sr-only">Process navigation</h2>
	{#if loading && !detail}
		<div class="rail-state">Loading this process timeline…</div>
	{:else if error && !detail}
		<div class="rail-state rail-error">{error}</div>
	{:else if detail}
		{#if railItems.length === 0}
			<div class="rail-state">No steps yet. Each turn will appear here as soon as the process starts working.</div>
		{:else}
			<div
				class="rail-list"
				bind:this={railListElement}
				data-section="turn-rail-list"
				aria-label="Process steps"
			>
				<div class="rail-track">
					{#each railItems as item, index (item.anchorId)}
						<button
							type="button"
							class="rail-item"
							class:is-active={activeAnchorId === item.anchorId}
							class:is-live={item.kind === "turn" && item.status === "in_progress"}
							aria-current={activeAnchorId === item.anchorId ? "step" : undefined}
							aria-label={itemAriaLabel(item)}
							data-active={activeAnchorId === item.anchorId ? "true" : "false"}
							data-rail-anchor-id={item.anchorId}
							data-rail-kind={item.kind}
							data-rail-tone={item.tone}
							data-rail-hierarchy={item.hierarchy}
							data-compact={compactRailItem(item) ? "true" : undefined}
							data-turn-id={itemTurnId(item)}
							data-turn-record-id={itemTurnRecordId(item)}
							data-turn-status={item.kind === "turn" ? item.status : undefined}
							data-section={itemSection(item)}
							data-terminal-status={itemTerminalStatus(item)}
							data-pressable="true"
							onclick={() => onSelectAnchor(item.anchorId)}
							onkeydown={(event) => handleRailKeydown(event, index)}
						>
							<span class="rail-marker" data-marker-shape={markerShape(item)}>
								<span>{item.markerText}</span>
							</span>
							<span class="rail-copy">
								<span class="rail-title">{item.title}</span>
								{#if showRailDetail(item)}
									<span class="rail-detail">{item.detail}</span>
								{/if}
							</span>
						</button>
					{/each}
				</div>
			</div>
			<p class="rail-help" aria-label="Keyboard shortcut: arrow up and arrow down move steps.">
				<kbd>↑/↓</kbd> move steps
			</p>
		{/if}
	{/if}
</section>

<style>
	.turn-rail {
		--terminal-aborted: #8a6044;

		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		width: 100%;
		min-width: 0;
		min-height: 0;
		padding: var(--space-xs) var(--space-sm) 0 0;
		border-right: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
		overflow: hidden;
	}

	.rail-state {
		margin: 0;
		font-size: 12px;
		color: var(--chronicle-text-muted);
	}

	.rail-error {
		color: var(--chronicle-danger-text);
	}

	.rail-list {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: var(--space-2xs) var(--space-2xs) var(--space-xs) 0;
	}

	.rail-track {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		min-width: 0;
	}

	.rail-track::before {
		content: "";
		position: absolute;
		top: var(--space-md);
		bottom: var(--space-md);
		left: 19px;
		width: 2px;
		background: color-mix(in srgb, var(--chronicle-accent) 12%, var(--chronicle-border) 88%);
		pointer-events: none;
	}

	.rail-item {
		position: relative;
		z-index: 1;
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr);
		gap: var(--space-xs);
		align-items: start;
		flex: 0 0 auto;
		min-height: 40px;
		padding: 6px var(--space-xs);
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		text-align: left;
		cursor: pointer;
		outline: none;
	}

	.rail-item[data-compact="true"] {
		align-items: center;
	}

	.rail-item[data-rail-hierarchy="secondary"] {
		margin-left: var(--space-lg);
		min-height: 34px;
		padding: 5px var(--space-xs);
		background: transparent;
		border-color: transparent;
	}

	.rail-item[data-rail-hierarchy="secondary"] .rail-marker {
		min-width: 20px;
		height: 20px;
		padding: 0 5px;
		font-size: 8.5px;
	}

	.rail-item:hover {
		background: color-mix(in srgb, var(--chronicle-accent) 7%, var(--chronicle-card-surface));
		border-color: color-mix(in srgb, var(--chronicle-accent) 38%, var(--chronicle-border) 62%);
	}

	.rail-item:focus-visible:not(.is-active) {
		outline: 2px solid var(--chronicle-accent);
		outline-offset: 2px;
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--chronicle-accent) 14%, transparent 86%);
	}

	.rail-item:focus-visible.is-active {
		outline: none;
	}

	.rail-item.is-active {
		background: color-mix(in srgb, var(--chronicle-accent) 12%, var(--chronicle-card-surface));
		border-color: color-mix(in srgb, var(--chronicle-accent) 60%, var(--chronicle-border) 40%);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--chronicle-accent) 38%, transparent 62%);
	}

	.rail-item.is-active .rail-title {
		font-weight: 700;
	}

	.rail-item[data-rail-hierarchy="secondary"].is-active {
		background: color-mix(in srgb, var(--chronicle-card-surface) 82%, var(--chronicle-accent-soft) 18%);
	}

	.rail-item[data-rail-tone="operator_decision"],
	.rail-item[data-rail-tone="scheduled_action"] {
		border-color: transparent;
		background: transparent;
	}

	.rail-item[data-rail-kind="action"][data-rail-tone="operator_decision"],
	.rail-item[data-rail-kind="action"][data-rail-tone="scheduled_action"] {
		border-color: color-mix(in srgb, var(--chronicle-accent) 54%, var(--chronicle-border) 46%);
		background: color-mix(in srgb, var(--chronicle-accent) 13%, var(--chronicle-card-surface));
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--chronicle-accent) 20%, transparent 80%);
	}

	.rail-item[data-rail-tone="error_recovery"] {
		border-color: color-mix(in srgb, var(--chronicle-danger) 32%, var(--chronicle-border) 68%);
		background: color-mix(in srgb, var(--chronicle-danger) 7%, var(--chronicle-card-surface));
	}

	.rail-item[data-rail-tone="external_trigger"] {
		border-color: color-mix(in srgb, var(--chronicle-attention) 34%, var(--chronicle-border) 66%);
		background: color-mix(in srgb, var(--chronicle-attention) 8%, var(--chronicle-card-surface));
	}

	.rail-marker {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 24px;
		height: 24px;
		padding: 0 6px;
		border: 1px solid var(--chronicle-border-strong);
		color: var(--chronicle-text);
		font-size: 9.5px;
		font-weight: 700;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		background: color-mix(in srgb, var(--chronicle-card-surface) 94%, var(--chronicle-panel-muted) 6%);
		box-shadow: 0 0 0 3px var(--chronicle-bg);
	}

	.rail-marker[data-marker-shape="circle"] {
		border-radius: 999px;
	}

	.rail-marker[data-marker-shape="diamond"] {
		transform: rotate(45deg);
		border-radius: 5px;
	}

	.rail-marker[data-marker-shape="diamond"] > span {
		transform: rotate(-45deg);
	}

	.rail-marker[data-marker-shape="pill"] {
		border-radius: 999px;
	}

	.rail-marker[data-marker-shape="square"] {
		border-radius: 6px;
	}

	.rail-item[data-rail-tone="prompt"] .rail-marker {
		border-color: color-mix(in srgb, var(--chronicle-accent) 50%, var(--chronicle-border-strong) 50%);
		background: color-mix(in srgb, var(--chronicle-accent) 12%, var(--chronicle-card-surface));
		color: var(--chronicle-accent);
	}

	.rail-item[data-rail-tone="llm_turn"] .rail-marker {
		border-color: color-mix(in srgb, var(--chronicle-accent) 40%, var(--chronicle-border-strong) 60%);
		background: color-mix(in srgb, var(--chronicle-accent) 7%, var(--chronicle-card-surface));
		color: color-mix(in srgb, var(--chronicle-accent) 80%, var(--chronicle-text) 20%);
	}

	.rail-item[data-rail-tone="automatic_turn"] .rail-marker {
		border-color: color-mix(in srgb, var(--chronicle-text-faint) 46%, var(--chronicle-border-strong) 54%);
		background: color-mix(in srgb, var(--chronicle-panel-muted) 34%, var(--chronicle-card-surface) 66%);
		color: color-mix(in srgb, var(--chronicle-text-muted) 88%, var(--chronicle-text) 12%);
	}

	.rail-item.is-active .rail-marker {
		border-color: color-mix(in srgb, var(--chronicle-accent) 64%, var(--chronicle-border-strong) 36%);
	}

	.rail-item.is-live .rail-marker {
		border-color: transparent;
		background: var(--chronicle-accent);
		color: var(--chronicle-text-on-accent);
		box-shadow:
			0 0 0 3px var(--chronicle-bg),
			0 0 0 5px color-mix(in srgb, var(--chronicle-accent) 40%, transparent 60%);
	}

	.rail-item.is-live .rail-title {
		color: color-mix(in srgb, var(--chronicle-accent) 72%, var(--chronicle-text) 28%);
	}

	.rail-item[data-rail-tone="operator_decision"] .rail-marker,
	.rail-item[data-rail-tone="scheduled_action"] .rail-marker {
		border-color: color-mix(in srgb, var(--chronicle-text-faint) 34%, var(--chronicle-border-strong) 66%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 96%, var(--chronicle-panel-muted) 4%);
		color: var(--chronicle-text-muted);
	}

	.rail-item[data-rail-kind="action"][data-rail-tone="operator_decision"] .rail-marker,
	.rail-item[data-rail-kind="action"][data-rail-tone="scheduled_action"] .rail-marker {
		border-color: color-mix(in srgb, var(--chronicle-accent) 36%, var(--chronicle-border-strong) 64%);
		background: color-mix(in srgb, var(--chronicle-accent) 8%, var(--chronicle-card-surface));
		color: color-mix(in srgb, var(--chronicle-accent) 62%, var(--chronicle-text) 38%);
	}

	.rail-item[data-rail-tone="error_recovery"] .rail-marker {
		border-color: color-mix(in srgb, var(--chronicle-danger) 52%, var(--chronicle-border-strong) 48%);
		background: color-mix(in srgb, var(--chronicle-danger) 13%, var(--chronicle-card-surface));
		color: var(--chronicle-danger);
	}

	.rail-item[data-rail-tone="external_trigger"] .rail-marker {
		border-color: color-mix(in srgb, var(--chronicle-attention) 52%, var(--chronicle-border-strong) 48%);
		background: color-mix(in srgb, var(--chronicle-attention) 14%, var(--chronicle-card-surface));
		color: var(--chronicle-attention);
	}

	.rail-item[data-rail-tone="terminal"] {
		border-color: transparent;
		background: transparent;
	}

	.rail-item[data-terminal-status="completed"]:hover,
	.rail-item[data-terminal-status="completed"].is-active {
		border-color: color-mix(in srgb, var(--chronicle-success) 42%, var(--chronicle-border) 58%);
		background: color-mix(in srgb, var(--chronicle-success) 8%, var(--chronicle-card-surface) 92%);
	}

	.rail-item[data-terminal-status="aborted"]:hover,
	.rail-item[data-terminal-status="aborted"].is-active {
		border-color: color-mix(in srgb, var(--terminal-aborted) 42%, var(--chronicle-border) 58%);
		background: color-mix(in srgb, white 91%, var(--terminal-aborted) 9%);
	}

	.rail-item[data-terminal-status="completed"].is-active {
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--chronicle-success) 22%, transparent 78%);
	}

	.rail-item[data-terminal-status="aborted"].is-active {
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--terminal-aborted) 20%, transparent 80%);
	}

	.rail-item[data-rail-tone="terminal"] .rail-marker {
		border-color: color-mix(in srgb, var(--chronicle-text-faint) 46%, var(--chronicle-border-strong) 54%);
		background: color-mix(in srgb, var(--chronicle-panel-muted) 28%, var(--chronicle-card-surface) 72%);
		color: color-mix(in srgb, var(--chronicle-text-muted) 88%, var(--chronicle-text) 12%);
	}

	.rail-item[data-terminal-status="completed"] .rail-marker {
		border-color: color-mix(in srgb, var(--chronicle-success) 34%, var(--chronicle-border) 66%);
		background: color-mix(in srgb, var(--chronicle-success) 8%, var(--chronicle-card-surface) 92%);
		color: color-mix(in srgb, var(--chronicle-success) 72%, var(--chronicle-text) 28%);
	}

	.rail-item[data-terminal-status="aborted"] .rail-marker {
		border-color: color-mix(in srgb, var(--terminal-aborted) 34%, var(--chronicle-border) 66%);
		background: color-mix(in srgb, white 91%, var(--terminal-aborted) 9%);
		color: color-mix(in srgb, var(--terminal-aborted) 76%, var(--chronicle-text) 24%);
	}

	.rail-copy {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		min-width: 0;
		padding-top: 1px;
	}

	.rail-item[data-compact="true"] .rail-copy {
		justify-content: center;
		align-items: flex-start;
		gap: 0;
		text-align: left;
	}

	.rail-title {
		font-size: 12px;
		font-weight: 640;
		line-height: 1.3;
		color: var(--chronicle-text);
	}

	.rail-item[data-rail-hierarchy="primary"] .rail-title {
		font-size: 13px;
		font-weight: 670;
	}

	.rail-detail {
		font-size: 11px;
		line-height: 1.4;
		color: var(--chronicle-text-muted);
	}

	.rail-item[data-rail-tone="operator_decision"] .rail-title,
	.rail-item[data-rail-tone="scheduled_action"] .rail-title {
		color: var(--chronicle-text-muted);
		font-weight: 620;
	}

	.rail-item[data-rail-kind="action"][data-rail-tone="operator_decision"] .rail-title,
	.rail-item[data-rail-kind="action"][data-rail-tone="scheduled_action"] .rail-title {
		color: color-mix(in srgb, var(--chronicle-accent) 80%, var(--chronicle-text) 20%);
		font-weight: 720;
	}

	.rail-item[data-rail-tone="error_recovery"] .rail-title {
		color: color-mix(in srgb, var(--chronicle-danger-text) 84%, var(--chronicle-text) 16%);
	}

	.rail-item[data-rail-tone="external_trigger"] .rail-title {
		color: color-mix(in srgb, var(--chronicle-attention) 82%, var(--chronicle-text) 18%);
	}

	.rail-help {
		margin: 0;
		padding: var(--space-sm) var(--space-xs) 0 0;
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 78%, white 22%);
		font-size: 11px;
		line-height: 1.4;
		color: color-mix(in srgb, var(--chronicle-text-muted) 88%, var(--chronicle-text) 12%);
	}

	.rail-help kbd {
		font: inherit;
		font-weight: 720;
		color: var(--chronicle-text);
	}

	@media (max-width: 1024px) {
		.turn-rail {
			padding: 0 0 var(--space-lg);
			border-right: 0;
			border-bottom: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
			overflow: visible;
		}

		.rail-list {
			overflow-x: auto;
			overflow-y: hidden;
			scroll-snap-type: inline proximity;
			padding: var(--space-xs) 0 var(--space-sm);
		}

		.rail-track {
			flex-direction: row;
			gap: var(--space-xs);
			width: max-content;
			min-width: 100%;
		}

		.rail-track::before {
			display: none;
		}

		.rail-item {
			min-width: min(210px, calc(100vw - 44px));
			scroll-snap-align: center;
			padding: var(--space-xs) var(--space-sm);
		}

		.rail-item[data-rail-hierarchy="secondary"],
		.rail-item[data-rail-tone="operator_decision"],
		.rail-item[data-rail-tone="scheduled_action"] {
			margin-left: 0;
			margin-top: 0;
		}
	}
</style>

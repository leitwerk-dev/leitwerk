<script lang="ts">
import { tick } from "svelte";
import type { ProcessDetailData } from "../../lib/api";
import {
	buildChronicleRailRows,
	type ChronicleRepeatedTurns,
	formatRailElapsed,
} from "../lib/chronicle-rail-groups.js";
import type { ChronicleSelectableItem } from "../lib/chronicle-selectable-items.js";

interface Props {
	detail: ProcessDetailData | null;
	loading: boolean;
	error: string | null;
	railItems: readonly ChronicleSelectableItem[];
	activeAnchorId: string | null;
	onSelectAnchor: (anchorId: string) => void;
	headingId?: string;
}

let {
	detail,
	loading,
	error,
	railItems,
	activeAnchorId,
	onSelectAnchor,
	headingId = "process-navigation-heading",
}: Props = $props();
let railListElement = $state<HTMLDivElement | null>(null);
let expandedGroups = $state<Record<string, boolean>>({});
let previousAnchorId: string | null = null;
const rows = $derived(buildChronicleRailRows(railItems));
const records = $derived(
	new Map(detail?.timeline.turns.map((record) => [record.id, record]) ?? []),
);
const upcomingTurn = $derived(
	railItems.some((item) => item.kind === "turn" && item.status === "in_progress")
		? (detail?.plannedNextTurn ?? null)
		: null,
);

$effect(() => {
	const anchorId = activeAnchorId;
	if (!anchorId || anchorId === previousAnchorId) return;
	const previousGroup = groupForAnchor(previousAnchorId);
	const group = groupForAnchor(anchorId);
	previousAnchorId = anchorId;
	let restoreRailFocus = false;
	if (previousGroup && previousGroup.id !== group?.id) {
		const focusedAnchorId = railListElement?.querySelector<HTMLElement>(
			"[data-rail-anchor-id]:focus",
		)?.dataset.railAnchorId;
		restoreRailFocus = previousGroup.items.some((item) => item.anchorId === focusedAnchorId);
		expandedGroups = { ...expandedGroups, [previousGroup.id]: false };
	}
	if (group) expandedGroups = { ...expandedGroups, [group.id]: true };
	void tick().then(() => {
		if (activeAnchorId !== anchorId) return;
		const item = [
			...(railListElement?.querySelectorAll<HTMLElement>("[data-rail-anchor-id]") ?? []),
		].find((element) => element.dataset.railAnchorId === anchorId);
		if (restoreRailFocus) item?.focus({ preventScroll: true });
		item?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
	});
});

function groupForAnchor(anchorId: string | null): ChronicleRepeatedTurns | undefined {
	return rows.find(
		(row): row is ChronicleRepeatedTurns =>
			row.kind === "repeated" && row.items.some((item) => item.anchorId === anchorId),
	);
}

function handleRailKeydown(event: KeyboardEvent) {
	const buttons = [
		...(railListElement?.querySelectorAll<HTMLButtonElement>("[data-rail-control]") ?? []),
	];
	const index = buttons.indexOf(event.currentTarget as HTMLButtonElement);
	let nextIndex: number;
	switch (event.key) {
		case "ArrowRight":
		case "ArrowDown":
			nextIndex = Math.min(index + 1, buttons.length - 1);
			break;
		case "ArrowLeft":
		case "ArrowUp":
			nextIndex = Math.max(index - 1, 0);
			break;
		case "Home":
			nextIndex = 0;
			break;
		case "End":
			nextIndex = buttons.length - 1;
			break;
		default:
			return;
	}
	event.preventDefault();
	event.stopPropagation();
	const next = buttons[nextIndex];
	next?.focus();
	if (next?.dataset.railAnchorId) onSelectAnchor(next.dataset.railAnchorId);
}

function toggleGroup(group: ChronicleRepeatedTurns) {
	expandedGroups = { ...expandedGroups, [group.id]: !expandedGroups[group.id] };
}

function handleGroupKeydown(event: KeyboardEvent, group: ChronicleRepeatedTurns) {
	if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
		event.preventDefault();
		event.stopPropagation();
		expandedGroups = { ...expandedGroups, [group.id]: event.key === "ArrowRight" };
	} else handleRailKeydown(event);
}

function itemState(item: ChronicleSelectableItem): string {
	if (item.kind === "turn")
		return item.status === "in_progress"
			? "live"
			: item.shape === "square"
				? "failed"
				: "completed";
	if (item.kind === "terminal") return item.terminalStatus;
	if (item.kind === "action") return item.tone === "error_recovery" ? "failed" : "waiting";
	return "prompt";
}

function itemDetail(item: ChronicleSelectableItem): string | null {
	if (item.kind !== "turn") return item.detail;
	const record = records.get(item.turnRecordId);
	const elapsed = formatRailElapsed(record?.startedAt, record?.endedAt);
	const state = itemState(item);
	const decision = item.tone === "operator_decision" ? record?.outcome?.trim() : null;
	const completedLabel =
		decision && !["completed", "succeeded", "superseded"].includes(decision.toLowerCase())
			? decision.toLowerCase() === "approve"
				? "Approved"
				: decision
			: "Completed";
	const label = state === "live" ? "In progress" : state === "failed" ? "Failed" : completedLabel;
	return [label, elapsed].filter(Boolean).join(" · ");
}

function groupElapsed(group: ChronicleRepeatedTurns): string | null {
	return formatRailElapsed(
		records.get(group.items[0].turnRecordId)?.startedAt,
		records.get(group.items.at(-1)?.turnRecordId ?? "")?.endedAt,
	);
}
</script>

{#snippet turnItem(item: ChronicleSelectableItem)}
	{@const state = itemState(item)}
	{@const metadata = itemDetail(item)}
	<button
		type="button"
		class="rail-item"
		class:is-active={activeAnchorId === item.anchorId}
		aria-current={activeAnchorId === item.anchorId ? "step" : undefined}
		aria-label={[item.title, item.label, metadata].filter(Boolean).join(" — ")}
		data-active={activeAnchorId === item.anchorId ? "true" : "false"}
		data-rail-control
		data-rail-anchor-id={item.anchorId}
		data-rail-kind={item.kind}
		data-rail-tone={item.tone}
		data-rail-hierarchy={item.hierarchy}
		data-turn-id={item.kind === "turn" ? item.turnId : undefined}
		data-turn-record-id={item.kind === "turn" ? item.turnRecordId : undefined}
		data-turn-status={item.kind === "turn" ? item.status : undefined}
		data-state={state}
		data-section={item.kind === "action" ? "action-required-indicator" : item.kind === "terminal" ? "terminal-state-indicator" : undefined}
		data-terminal-status={item.kind === "terminal" ? item.terminalStatus : undefined}
		data-pressable="true"
		onclick={() => onSelectAnchor(item.anchorId)}
		onkeydown={handleRailKeydown}
	>
		<span class="rail-marker" aria-hidden="true">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				{#if state === "completed"}<path d="m5 12 4 4L19 6" />
				{:else if state === "live"}<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
				{:else if state === "waiting"}<circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" />
				{:else if state === "failed" || state === "aborted"}<path d="m7 7 10 10M17 7 7 17" />
				{:else if state === "prompt"}<path d="M8 4h6l3 3v13H7V4h1m3 6h3m-3 4h3" />
				{/if}
			</svg>
		</span>
		<span class="rail-copy">
			<span class="rail-title">{item.title}</span>
			{#if metadata}<span class="rail-detail">{metadata}</span>{/if}
		</span>
	</button>
{/snippet}

<section class="turn-rail" data-column="turn-rail" aria-labelledby={headingId}>
	<h2 id={headingId} class="sr-only">Process navigation</h2>
	{#if loading && !detail}
		<div class="rail-state">Loading this process timeline…</div>
	{:else if error && !detail}
		<div class="rail-state rail-error">{error}</div>
	{:else if detail}
		{#if railItems.length === 0}
			<div class="rail-state">No turns yet. Each turn will appear here when the process starts.</div>
		{:else}
			<div class="rail-list" bind:this={railListElement} data-section="turn-rail-list" aria-label="Process steps">
				<div class="rail-track">
					{#each rows as row (row.id)}
						{#if row.kind === "item"}
							{@render turnItem(row.item)}
						{:else}
							{@const expanded = expandedGroups[row.id] ?? false}
							{@const elapsed = groupElapsed(row)}
							<div class="repeated-turns" data-section="repeated-turns" data-expanded={expanded}>
								<button type="button" class="repeat-toggle" data-rail-control aria-expanded={expanded} aria-controls={`${headingId}-${row.id}`} onclick={() => toggleGroup(row)} onkeydown={(event) => handleGroupKeydown(event, row)}>
									<span class="rail-marker repeat-marker" aria-hidden="true">
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4M4 11V9a2 2 0 0 1 2-2h14M8 21l-4-4 4-4m12 0v2a2 2 0 0 1-2 2H4" /></svg>
									</span>
									<span class="rail-copy">
										<span class="rail-title">Repeated Turns</span>
										<span class="repeat-sequence">{row.sequence}</span>
										<span class="repeat-meta"><span>{row.items.length} turns</span>{#if elapsed}<span aria-hidden="true">·</span><span>{elapsed}</span>{/if}</span>
									</span>
									<svg class="repeat-chevron" class:is-expanded={expanded} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
								</button>
								<div class="repeat-items" id={`${headingId}-${row.id}`} hidden={!expanded}>
									{#if expanded}{#each row.items as item (item.anchorId)}{@render turnItem(item)}{/each}{/if}
								</div>
							</div>
						{/if}
					{/each}
					{#if upcomingTurn}
						<div class="rail-item rail-upcoming" data-section="upcoming-turn" data-state="pending">
							<span class="rail-marker" aria-hidden="true"></span>
							<span class="rail-copy"><span class="rail-title">{upcomingTurn.description}</span><span class="rail-detail">Pending</span></span>
						</div>
					{/if}
				</div>
			</div>
			<p class="rail-help" aria-label="Keyboard shortcut: arrow up and arrow down move steps."><kbd>↑/↓</kbd> move steps</p>
		{/if}
	{/if}
</section>

<style>
	.turn-rail {
		--rail-marker-size: 24px;
		--rail-axis: 20px;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		width: 100%;
		min-width: 0;
		min-height: 0;
		padding: var(--space-xs) var(--space-sm) 0 0;
		border-right: 1px solid var(--chronicle-border);
		overflow: hidden;
	}

	.rail-state {
		font-size: var(--type-caption);
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
		scrollbar-gutter: stable;
		padding: var(--space-2xs) var(--space-2xs) var(--space-xs) 0;
	}

	.rail-track {
		position: relative;
		isolation: isolate;
		display: flex;
		flex-direction: column;
		gap: var(--space-2xs);
		min-width: 0;
	}

	.rail-track::before {
		content: "";
		position: absolute;
		z-index: 1;
		top: 24px;
		bottom: 24px;
		left: var(--rail-axis);
		transform: translateX(-50%);
		width: 1px;
		background: var(--chronicle-border);
		pointer-events: none;
	}

	.rail-item, .repeat-toggle {
		position: relative;
		z-index: 2;
		display: grid;
		grid-template-columns: var(--rail-marker-size) minmax(0, 1fr);
		gap: var(--space-xs);
		align-items: start;
		width: 100%;
		min-width: 0;
		min-height: 48px;
		padding: var(--space-xs);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--chronicle-text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.rail-item:hover, .repeat-toggle:hover {
		background: color-mix(in srgb, var(--chronicle-accent) 5%, transparent);
	}

	.rail-item:focus-visible, .repeat-toggle:focus-visible {
		outline: 2px solid var(--chronicle-accent);
		outline-offset: -2px;
	}

	.rail-item.is-active {
		background: color-mix(in srgb, var(--chronicle-accent) 8%, transparent);
	}

	.rail-marker {
		display: grid;
		place-items: center;
		width: var(--rail-marker-size);
		height: var(--rail-marker-size);
		border: 1px solid var(--chronicle-border-strong);
		border-radius: 50%;
		color: var(--chronicle-text-muted);
		background: var(--chronicle-bg);
	}

	.rail-marker svg {
		width: 16px;
		height: 16px;
	}

	.rail-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		padding-top: 2px;
		overflow-wrap: anywhere;
	}

	.rail-title {
		color: var(--chronicle-text);
		font-size: var(--type-body-sm);
		font-weight: 620;
		line-height: 1.4;
	}

	.rail-detail, .repeat-sequence, .repeat-meta {
		color: var(--chronicle-text-muted);
		font-size: 11px;
		line-height: 1.5;
	}

	.rail-detail, .repeat-meta {
		font-variant-numeric: tabular-nums;
	}

	.rail-item[data-state="completed"] .rail-marker {
		color: var(--chronicle-success);
		border-color: color-mix(in srgb, var(--chronicle-success) 35%, var(--chronicle-border));
		background: var(--chronicle-success-surface);
	}

	.rail-item[data-state="live"] .rail-marker {
		color: var(--chronicle-text-on-accent);
		border-color: var(--chronicle-accent);
		background: var(--chronicle-accent);
	}

	.rail-item[data-state="live"] .rail-title {
		color: var(--chronicle-accent);
	}

	.rail-item[data-state="waiting"] .rail-marker {
		color: var(--chronicle-text-on-accent);
		border-color: var(--chronicle-attention);
		background: var(--chronicle-attention);
	}

	.rail-item[data-state="waiting"] .rail-title {
		color: color-mix(in srgb, var(--chronicle-attention) 78%, var(--chronicle-text) 22%);
	}

	.rail-item:is([data-state="live"], [data-state="waiting"]) .rail-title {
		font-weight: 700;
	}

	.rail-item[data-state="failed"] .rail-marker {
		color: var(--chronicle-danger);
		border-color: var(--chronicle-danger-border);
		background: var(--chronicle-danger-surface);
	}

	.rail-item[data-state="aborted"] .rail-marker {
		color: var(--chronicle-text-muted);
		background: var(--chronicle-panel-muted);
	}

	.repeated-turns {
		position: relative;
		margin-block: var(--space-2xs);
		padding-bottom: var(--space-2xs);
	}

	.repeated-turns::before {
		content: "";
		position: absolute;
		z-index: 0;
		inset: 0;
		border: 1px solid var(--chronicle-border);
		border-radius: var(--radius-sm);
		background: var(--chronicle-card-surface-strong);
		pointer-events: none;
	}

	.repeated-turns[data-expanded="false"] {
		padding-bottom: 0;
	}

	.repeat-toggle {
		grid-template-columns: var(--rail-marker-size) minmax(0, 1fr) 12px;
		gap: var(--space-xs);
		padding-block: var(--space-sm);
	}

	.repeat-marker {
		background: var(--chronicle-card-surface-strong);
	}

	.repeat-items:not([hidden]) {
		display: flex;
		flex-direction: column;
		gap: var(--space-2xs);
	}

	.repeat-sequence {
		margin-top: 2px;
	}

	.repeat-meta {
		display: flex;
		flex-wrap: wrap;
		column-gap: var(--space-2xs);
	}

	.repeat-chevron {
		width: 12px;
		height: 12px;
		margin-top: 6px;
		color: var(--chronicle-text-faint);
	}

	.repeat-chevron.is-expanded {
		transform: rotate(90deg);
	}

	.rail-upcoming {
		cursor: default;
	}

	.rail-upcoming:hover {
		background: transparent;
	}

	.rail-help {
		margin: 0;
		padding: var(--space-xs) 0;
		border-top: 1px solid var(--chronicle-border);
		color: var(--chronicle-text-muted);
		font-size: 11px;
	}

	.rail-help kbd {
		font: inherit;
		font-weight: 650;
	}
</style>

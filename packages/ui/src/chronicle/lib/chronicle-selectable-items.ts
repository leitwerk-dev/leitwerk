import { getProcessTerminalIcon } from "../../lib/process-terminal-display.js";
import type { ChronicleProjection, ChronicleTerminalRailItem } from "./chronicle-projection.js";
import type { ChronicleTurnShape } from "./chronicle-view-model.js";

export const CHRONICLE_ACTION_SECTION_ANCHOR_ID = "chronicle-action-section";
export const CHRONICLE_PROCESS_ERROR_SECTION_ANCHOR_ID = "chronicle-process-error-section";

export type ChronicleSelectableHierarchy = "primary" | "secondary";
export type ChronicleSelectableTone =
	| "prompt"
	| "llm_turn"
	| "automatic_turn"
	| "operator_decision"
	| "external_trigger"
	| "terminal"
	| "scheduled_action"
	| "error_recovery";

interface ChronicleSelectableBaseItem {
	anchorId: string;
	label: string;
	title: string;
	detail: string | null;
	hierarchy: ChronicleSelectableHierarchy;
	tone: ChronicleSelectableTone;
	markerText: string;
}

export interface ChronicleSelectablePromptItem extends ChronicleSelectableBaseItem {
	kind: "prompt";
}

export interface ChronicleSelectableTurnItem extends ChronicleSelectableBaseItem {
	kind: "turn";
	turnId: string;
	turnRecordId: string;
	status: "completed" | "in_progress";
	shape: ChronicleTurnShape;
}

export interface ChronicleSelectableTerminalItem extends ChronicleSelectableBaseItem {
	kind: "terminal";
	terminalStatus: ChronicleTerminalRailItem["terminalStatus"];
}

export interface ChronicleSelectableActionItem extends ChronicleSelectableBaseItem {
	kind: "action";
	anchorId: string;
	turnRecordId?: string;
}

export type ChronicleSelectableItem =
	| ChronicleSelectablePromptItem
	| ChronicleSelectableTurnItem
	| ChronicleSelectableTerminalItem
	| ChronicleSelectableActionItem;

export interface ChroniclePendingRailItem {
	label: string;
	title: string;
	detail?: string | null;
	anchorId?: string;
	tone: Extract<
		ChronicleSelectableTone,
		"operator_decision" | "external_trigger" | "scheduled_action" | "error_recovery"
	>;
	markerText?: string;
	relatedTurnRecordId?: string;
	replaceTurnRecordId?: string;
}

interface BuildChronicleSelectableItemsInput {
	projection: Pick<
		ChronicleProjection,
		"promptItem" | "turnRailItems" | "terminalRailItem" | "timelineItems"
	>;
	pendingRailItem: ChroniclePendingRailItem | null;
}

function buildPromptItem(
	promptItem: NonNullable<ChronicleProjection["promptItem"]>,
): ChronicleSelectablePromptItem {
	return {
		kind: "prompt",
		anchorId: promptItem.anchorId,
		label: "Prompt",
		title: "Initial prompt",
		detail: null,
		hierarchy: "primary",
		tone: "prompt",
		markerText: "P",
	};
}

function buildTerminalItem(
	terminalRailItem: ChronicleTerminalRailItem,
): ChronicleSelectableTerminalItem {
	return {
		kind: "terminal",
		anchorId: terminalRailItem.anchorId,
		label: "Process state",
		title: terminalRailItem.title,
		detail: null,
		hierarchy: "primary",
		tone: "terminal",
		markerText: getProcessTerminalIcon(terminalRailItem.terminalStatus),
		terminalStatus: terminalRailItem.terminalStatus,
	};
}

function retryLineageRootTurnRecordId(
	item: Pick<
		ChronicleProjection["turnRailItems"][number],
		"turnRecordId" | "retryLineageRootTurnRecordId"
	>,
): string {
	return item.retryLineageRootTurnRecordId ?? item.turnRecordId;
}

function sharesRetryLineage(
	left: Pick<
		ChronicleProjection["turnRailItems"][number],
		"turnId" | "turnRecordId" | "retryLineageRootTurnRecordId"
	>,
	right: Pick<
		ChronicleProjection["turnRailItems"][number],
		"turnId" | "turnRecordId" | "retryLineageRootTurnRecordId"
	>,
): boolean {
	return (
		left.turnId === right.turnId &&
		retryLineageRootTurnRecordId(left) === retryLineageRootTurnRecordId(right)
	);
}

export function buildChronicleSelectableItems(
	input: BuildChronicleSelectableItemsInput,
): ChronicleSelectableItem[] {
	const items: ChronicleSelectableItem[] = [];
	if (input.projection.promptItem) {
		items.push(buildPromptItem(input.projection.promptItem));
	}

	const turnRailItemsByTurnRecordId = new Map(
		input.projection.turnRailItems.map((item) => [item.turnRecordId, item]),
	);
	let llmTurnCount = 0;

	for (let index = 0; index < input.projection.timelineItems.length; index += 1) {
		const timelineItem = input.projection.timelineItems[index];
		if (timelineItem.kind === "turn_cluster" || timelineItem.kind === "live_tail") {
			if (
				input.pendingRailItem?.replaceTurnRecordId &&
				timelineItem.turnRecordId === input.pendingRailItem.replaceTurnRecordId
			) {
				continue;
			}
			const railItem = turnRailItemsByTurnRecordId.get(timelineItem.turnRecordId);
			if (!railItem) {
				continue;
			}
			const nextTurnLikeItem = input.projection.timelineItems
				.slice(index + 1)
				.find((item) => item.kind === "turn_cluster" || item.kind === "live_tail");
			const nextRailItem = nextTurnLikeItem
				? turnRailItemsByTurnRecordId.get(nextTurnLikeItem.turnRecordId)
				: undefined;
			if (nextRailItem && sharesRetryLineage(railItem, nextRailItem)) {
				continue;
			}
			if (railItem.presentation === "llm_turn") {
				llmTurnCount += 1;
			}
			items.push({
				kind: "turn",
				anchorId: railItem.anchorId,
				turnId: railItem.turnId,
				turnRecordId: railItem.turnRecordId,
				label: railItem.kindLabel,
				title: railItem.title,
				detail: null,
				hierarchy: railItem.hierarchy,
				tone: railItem.presentation,
				markerText:
					railItem.presentation === "llm_turn"
						? String(llmTurnCount)
						: railItem.presentation === "automatic_turn"
							? "Auto"
							: railItem.presentation === "external_trigger"
								? "Ext"
								: "You",
				status: railItem.status,
				shape: railItem.shape,
			});
		}

		// Leaf outcomes are sub-content of their owning turn and are intentionally
		// not surfaced as standalone rail waypoints. The rail is a turn-level
		// navigator; a result is reached by selecting its parent turn. Scroll sync
		// maps a leaf outcome scrolled into view back to its parent turn rail item
		// (see resolveChronicleRailAnchorIdFromActiveAnchor).
	}

	if (input.projection.terminalRailItem) {
		items.push(buildTerminalItem(input.projection.terminalRailItem));
	}
	if (input.pendingRailItem) {
		items.push({
			kind: "action",
			anchorId: input.pendingRailItem.anchorId ?? CHRONICLE_ACTION_SECTION_ANCHOR_ID,
			label: input.pendingRailItem.label,
			title: input.pendingRailItem.title,
			detail: input.pendingRailItem.detail ?? null,
			hierarchy: "secondary",
			tone: input.pendingRailItem.tone,
			markerText:
				input.pendingRailItem.markerText ??
				(input.pendingRailItem.tone === "external_trigger"
					? "Ext"
					: input.pendingRailItem.tone === "error_recovery"
						? "!"
						: "You"),
			...(input.pendingRailItem.relatedTurnRecordId
				? { turnRecordId: input.pendingRailItem.relatedTurnRecordId }
				: {}),
		});
	}

	return items;
}

export function findChronicleSelectableItem(
	items: readonly ChronicleSelectableItem[],
	anchorId: string | null,
): ChronicleSelectableItem | null {
	if (!anchorId) {
		return null;
	}
	return items.find((item) => item.anchorId === anchorId) ?? null;
}

export function moveChronicleAnchorByOffset(
	items: readonly ChronicleSelectableItem[],
	currentAnchorId: string | null,
	offset: number,
): string | null {
	if (items.length === 0) {
		return null;
	}
	const currentIndex = items.findIndex((item) => item.anchorId === currentAnchorId);
	const safeCurrentIndex = currentIndex >= 0 ? currentIndex : items.length - 1;
	const nextIndex = Math.max(0, Math.min(safeCurrentIndex + offset, items.length - 1));
	return items[nextIndex]?.anchorId ?? null;
}

export function resolveChronicleRailAnchorIdFromActiveAnchor(
	projection: Pick<ChronicleProjection, "turnRailItems" | "timelineItems">,
	items: readonly ChronicleSelectableItem[],
	activeAnchorId: string | null,
): string | null {
	const directMatch = findChronicleSelectableItem(items, activeAnchorId);
	if (directMatch) {
		return directMatch.anchorId;
	}
	if (!activeAnchorId) {
		return null;
	}

	const turnRailItemsByTurnRecordId = new Map(
		projection.turnRailItems.map((item) => [item.turnRecordId, item]),
	);

	// Leaf outcomes are no longer standalone rail waypoints. When a leaf outcome
	// scrolls into view, highlight its owning turn rail item instead of leaving
	// the rail blank.
	const leafOutcomeTimelineItem = projection.timelineItems.find(
		(item) => item.kind === "leaf_outcome" && item.anchorId === activeAnchorId,
	);
	if (leafOutcomeTimelineItem && leafOutcomeTimelineItem.kind === "leaf_outcome") {
		const ownerTurnRecordId = leafOutcomeTimelineItem.turnRecordId;
		if (ownerTurnRecordId) {
			const ownerTurnRailItem = turnRailItemsByTurnRecordId.get(ownerTurnRecordId);
			const ownerTurnAnchor = [...items].reverse().find((item) => {
				if (item.kind !== "turn") {
					return false;
				}
				if (item.turnRecordId === ownerTurnRecordId) {
					return true;
				}
				const visibleTurnRailItem = turnRailItemsByTurnRecordId.get(item.turnRecordId);
				return Boolean(
					ownerTurnRailItem &&
						visibleTurnRailItem &&
						sharesRetryLineage(ownerTurnRailItem, visibleTurnRailItem),
				);
			});
			if (ownerTurnAnchor) {
				return ownerTurnAnchor.anchorId;
			}
		}
	}

	const hiddenTurnRailItem = projection.turnRailItems.find(
		(item) => item.anchorId === activeAnchorId,
	);
	if (!hiddenTurnRailItem) {
		return null;
	}

	const replacementActionItem = items.find(
		(item) => item.kind === "action" && item.turnRecordId === hiddenTurnRailItem.turnRecordId,
	);
	if (replacementActionItem) {
		return replacementActionItem.anchorId;
	}

	const replacementTurnItem = [...items].reverse().find((item) => {
		if (item.kind !== "turn") {
			return false;
		}
		const visibleTurnRailItem = turnRailItemsByTurnRecordId.get(item.turnRecordId);
		if (!visibleTurnRailItem) {
			return item.turnRecordId === hiddenTurnRailItem.turnRecordId;
		}
		return sharesRetryLineage(hiddenTurnRailItem, visibleTurnRailItem);
	});
	return replacementTurnItem?.anchorId ?? null;
}

export function resolveSelectableTurnAnchorId(
	projection: Pick<ChronicleProjection, "turnRailItems">,
	turnRecordId: string,
): string | null {
	return (
		projection.turnRailItems.find((item) => item.turnRecordId === turnRecordId)?.anchorId ?? null
	);
}

export function resolveChronicleTurnRecordIdForAnchor(
	items: readonly ChronicleSelectableItem[],
	anchorId: string | null,
): string | null {
	const item = findChronicleSelectableItem(items, anchorId);
	if (!item) {
		return null;
	}
	return item.kind === "turn"
		? item.turnRecordId
		: item.kind === "action"
			? (item.turnRecordId ?? null)
			: null;
}

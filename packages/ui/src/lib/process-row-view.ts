import { type ProcessRowSlot, sortProcessRows } from "@leitwerk-dev/domain";
import type { ProcessOverviewItem } from "./api.js";
import { formatDefinition, formatStatus, formatTurnId } from "./format.js";

export interface ProcessRowView extends ProcessRowSlot {
	processDisplayName: string;
	statusLabel: string;
	turnLabel: string | null;
	statusLine: string;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
	initialPrompt: string | null;
}

function buildStatusLine(row: ProcessRowSlot): string {
	const statusLabel = formatStatus(row.lifecycleStatus);
	return row.selectedTurnId ? `${statusLabel} · ${formatTurnId(row.selectedTurnId)}` : statusLabel;
}

function resolveProcessDisplayName(item: ProcessOverviewItem): string {
	const processDisplayName = item.processDisplayName?.trim();
	return processDisplayName || formatDefinition(item.processId);
}

export function buildProcessRowView(item: ProcessOverviewItem): ProcessRowView {
	const row: ProcessRowSlot = item;
	return {
		...row,
		processDisplayName: resolveProcessDisplayName(item),
		statusLabel: formatStatus(row.lifecycleStatus),
		turnLabel: row.selectedTurnId ? formatTurnId(row.selectedTurnId) : null,
		statusLine: buildStatusLine(row),
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		closedAt: row.statusCategory === "terminal" ? item.closedAt : null,
		initialPrompt: item.initialPromptPreview,
	};
}

function closedAtTimestamp(row: ProcessRowView): number {
	const timestamp = Date.parse(row.closedAt ?? "");
	return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareTerminalRows(a: ProcessRowView, b: ProcessRowView): number {
	return (
		closedAtTimestamp(b) - closedAtTimestamp(a) ||
		a.title.localeCompare(b.title) ||
		a.instanceId.localeCompare(b.instanceId)
	);
}

export function sortProcessRowViews(rows: readonly ProcessRowView[]): ProcessRowView[] {
	const sorted = sortProcessRows([...rows]) as ProcessRowView[];
	return [
		...sorted.filter((row) => row.statusCategory !== "terminal"),
		...sorted.filter((row) => row.statusCategory === "terminal").sort(compareTerminalRows),
	];
}

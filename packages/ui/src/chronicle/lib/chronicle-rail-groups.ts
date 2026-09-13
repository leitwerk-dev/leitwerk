import type { ProcessTimelineTurnSummary } from "@leitwerk-dev/protocol";
import type {
	ChronicleSelectableItem,
	ChronicleSelectableTurnItem,
} from "./chronicle-selectable-items.js";
import { groupRetryChains } from "./retry-groups.js";

export interface ChronicleRepeatedTurns {
	kind: "repeated";
	retryCount?: number;
	id: string;
	sequence: string;
	items: ChronicleSelectableTurnItem[];
}

export type ChronicleRailRow =
	| { kind: "item"; id: string; item: ChronicleSelectableItem }
	| ChronicleRepeatedTurns;

function isHistoricalTurn(item: ChronicleSelectableItem): item is ChronicleSelectableTurnItem {
	return item.kind === "turn" && item.status === "completed" && item.shape !== "square";
}

/** Fold consecutive complete cycles; keep the latest result beside its pending decision. */
export function buildChronicleRailRows(
	items: readonly ChronicleSelectableItem[],
	records?: readonly ProcessTimelineTurnSummary[],
): ChronicleRailRow[] {
	if (records) {
		const byId = new Map(records.map((record) => [record.id, record]));
		const groups = groupRetryChains(items, (item) => {
			if (item.kind !== "turn") return null;
			const record = byId.get(item.turnRecordId);
			return record
				? {
						id: record.id,
						turnId: record.turnId,
						parentTurnRecordId: record.parentTurnRecordId,
						failed: record.outcome === "failed",
					}
				: null;
		});
		const rows: ChronicleRailRow[] = [];
		let pending: ChronicleSelectableItem[] = [];
		for (const group of groups) {
			if (group.length === 1) {
				pending.push(group[0]);
				continue;
			}
			rows.push(...buildChronicleRailRows(pending));
			pending = [];
			const attempts = group as ChronicleSelectableTurnItem[];
			rows.push({
				kind: "repeated",
				id: attempts[0].anchorId,
				retryCount: attempts.length,
				sequence: attempts[0].title,
				items: attempts.slice(0, -1),
			});
			const latest = attempts[attempts.length - 1];
			rows.push({ kind: "item", id: latest.anchorId, item: latest });
		}
		return [...rows, ...buildChronicleRailRows(pending)];
	}

	const rows: ChronicleRailRow[] = [];
	const latestResultIndex =
		items.at(-1)?.kind === "action" || items.at(-1)?.kind === "terminal"
			? items.findLastIndex((item) => item.kind === "turn")
			: -1;
	let index = 0;
	while (index < items.length) {
		let end = index;
		while (end < items.length && end !== latestResultIndex && isHistoricalTurn(items[end])) end++;
		let period = 0;
		let length = 0;
		for (let candidate = 1; candidate <= Math.floor((end - index) / 2); candidate++) {
			let matched = candidate;
			while (index + matched < end) {
				const next = items[index + matched] as ChronicleSelectableTurnItem;
				const original = items[index + (matched % candidate)] as ChronicleSelectableTurnItem;
				if (next.turnId !== original.turnId) break;
				matched++;
			}
			const completeLength = matched - (matched % candidate);
			if (completeLength >= candidate * 2 && completeLength > length) {
				period = candidate;
				length = completeLength;
			}
		}
		if (period > 0) {
			const repeated = items.slice(index, index + length) as ChronicleSelectableTurnItem[];
			rows.push({
				kind: "repeated",
				id: repeated[0].anchorId,
				sequence: repeated
					.slice(0, period)
					.map((item) => item.title)
					.join(" → "),
				items: repeated,
			});
			index += length;
		} else {
			rows.push({ kind: "item", id: items[index].anchorId, item: items[index] });
			index++;
		}
	}
	return rows;
}

export function formatRailElapsed(
	startedAt?: string | null,
	endedAt?: string | null,
): string | null {
	if (!startedAt || !endedAt) return null;
	const elapsed = Date.parse(endedAt) - Date.parse(startedAt);
	if (!Number.isFinite(elapsed) || elapsed < 0) return null;
	const seconds = Math.floor(elapsed / 1000);
	if (seconds === 0) return "<1s";
	const parts: string[] = [];
	if (seconds >= 3600) parts.push(`${Math.floor(seconds / 3600)}h`);
	if (seconds >= 60) parts.push(`${Math.floor((seconds % 3600) / 60)}m`);
	parts.push(`${seconds % 60}s`);
	return parts.join(" ");
}

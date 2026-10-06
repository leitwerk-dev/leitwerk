import { and, gte, lte } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

/** @internal */
export interface HistoryWindow {
	/** @internal */
	since?: string;
	/** @internal */
	until?: string;
}

/** @internal */
export function historyWindow(column: SQLiteColumn, window?: HistoryWindow) {
	return and(
		window?.since ? gte(column, window.since) : undefined,
		window?.until ? lte(column, window.until) : undefined,
	);
}

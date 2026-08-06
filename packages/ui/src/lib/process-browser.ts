import type { ProcessLifecycleStatus } from "@leitwerk-dev/domain";
import type { ProcessBrowseItem, ProcessOverviewItem } from "@leitwerk-dev/protocol";
import * as v from "valibot";
import type { StorageLike } from "./browser-storage.js";
import { formatDefinition, formatStatus, formatTurnId } from "./format.js";

export const PROCESS_BROWSER_PAGE_SIZE = 100;

const processBrowserStatusFilterSchema = v.picklist([
	"all",
	"running",
	"scheduled",
	"needs_attention",
	"completed",
	"aborted",
]);
const processBrowserSortSchema = v.object({
	key: v.picklist(["status", "title", "timeline"]),
	direction: v.picklist(["asc", "desc"]),
});

export type ProcessBrowserStatusFilter = v.InferOutput<typeof processBrowserStatusFilterSchema>;
export type ProcessBrowserSort = v.InferOutput<typeof processBrowserSortSchema>;
export type ProcessBrowserSortKey = ProcessBrowserSort["key"];

export interface ProcessBrowserFilterState {
	status: ProcessBrowserStatusFilter;
	query: string;
	processType: string;
}

const processBrowserViewSchema = v.object({
	status: processBrowserStatusFilterSchema,
	processType: v.pipe(v.string(), v.maxLength(200)),
	sort: processBrowserSortSchema,
});
export type ProcessBrowserViewPreference = v.InferOutput<typeof processBrowserViewSchema>;

const PROCESS_BROWSER_VIEW_STORAGE_KEY = "leitwerk.process-browser-view.v1";
export const DEFAULT_PROCESS_BROWSER_VIEW: ProcessBrowserViewPreference = {
	status: "all",
	processType: "",
	sort: { key: "timeline", direction: "desc" },
};
export const EMPTY_PROCESS_BROWSER_STATUS_COUNTS: Record<ProcessBrowserStatusFilter, number> = {
	all: 0,
	running: 0,
	scheduled: 0,
	needs_attention: 0,
	completed: 0,
	aborted: 0,
};

export function readProcessBrowserView(storage: StorageLike | null): ProcessBrowserViewPreference {
	try {
		const raw = storage?.getItem(PROCESS_BROWSER_VIEW_STORAGE_KEY);
		const result = raw && v.safeParse(processBrowserViewSchema, JSON.parse(raw));
		return result?.success ? result.output : DEFAULT_PROCESS_BROWSER_VIEW;
	} catch {
		return DEFAULT_PROCESS_BROWSER_VIEW;
	}
}

export function writeProcessBrowserView(
	storage: StorageLike | null,
	preference: ProcessBrowserViewPreference,
): void {
	try {
		storage?.setItem(PROCESS_BROWSER_VIEW_STORAGE_KEY, JSON.stringify(preference));
	} catch {
		// Preferences must never block browsing.
	}
}

interface ProcessBrowserItemBase {
	id: string;
	kind: "process" | "future";
	title: string;
	processId: string;
	processDisplayName: string;
	statusFilter: Exclude<ProcessBrowserStatusFilter, "all">;
	statusDetail: string;
	initialPrompt: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	sortAt: string | null;
}

export interface ProcessBrowserProcessItem extends ProcessBrowserItemBase {
	kind: "process";
	instanceId: string;
	futureExecutionId: null;
	lifecycleStatus: ProcessLifecycleStatus;
}

export interface ProcessBrowserFutureItem extends ProcessBrowserItemBase {
	kind: "future";
	instanceId: string | null;
	futureExecutionId: string | null;
	lifecycleStatus: null;
}

export type ProcessBrowserItem = ProcessBrowserProcessItem | ProcessBrowserFutureItem;

function statusFilterForProcess(
	item: ProcessOverviewItem,
): Exclude<ProcessBrowserStatusFilter, "all"> {
	if (item.lifecycleStatus === "completed" || item.lifecycleStatus === "aborted") {
		return item.lifecycleStatus;
	}
	return item.lifecycleStatus === "error" || item.lifecycleStatus === "waiting"
		? "needs_attention"
		: "running";
}

function statusLine(item: ProcessOverviewItem): string {
	const status = formatStatus(item.lifecycleStatus);
	return item.selectedTurnId ? `${status} · ${formatTurnId(item.selectedTurnId)}` : status;
}

export function buildProcessBrowserItem(entry: ProcessBrowseItem): ProcessBrowserItem {
	if (entry.kind === "process") {
		const item = entry.item;
		return {
			id: item.instanceId,
			kind: "process",
			title: item.title,
			processId: item.processId,
			processDisplayName: item.processDisplayName?.trim() || formatDefinition(item.processId),
			statusFilter: statusFilterForProcess(item),
			statusDetail: statusLine(item),
			initialPrompt: item.initialPromptPreview,
			createdAt: item.createdAt,
			updatedAt: item.updatedAt,
			sortAt:
				item.statusCategory === "terminal"
					? (item.closedAt ?? item.updatedAt ?? item.createdAt)
					: (item.updatedAt ?? item.createdAt),
			instanceId: item.instanceId,
			futureExecutionId: null,
			lifecycleStatus: item.lifecycleStatus,
		};
	}
	const item = entry.item;
	return {
		id: item.id,
		kind: "future",
		title: item.title,
		processId: item.processId,
		processDisplayName:
			item.kind === "launch"
				? item.launcherLabel || formatDefinition(item.processId)
				: formatDefinition(item.processId),
		statusFilter: "scheduled",
		statusDetail:
			item.kind === "action"
				? `Scheduled action · ${item.actionLabel}`
				: item.scheduleKind === "cron"
					? "Recurring scheduled start"
					: "Scheduled start",
		initialPrompt: item.initialPromptPreview,
		createdAt: null,
		updatedAt: item.nextRunAt,
		sortAt: item.nextRunAt,
		instanceId: item.instanceId,
		futureExecutionId: item.kind === "launch" ? item.id : null,
		lifecycleStatus: null,
	};
}

export function buildProcessBrowserItems(
	entries: readonly ProcessBrowseItem[],
): ProcessBrowserItem[] {
	return entries.map(buildProcessBrowserItem);
}

export function hasActiveFilters(filters: ProcessBrowserFilterState): boolean {
	return filters.status !== "all" || filters.query.trim() !== "" || filters.processType !== "";
}

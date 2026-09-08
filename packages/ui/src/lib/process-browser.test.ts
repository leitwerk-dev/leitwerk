import type { ProcessBrowseItem, ProcessOverviewItem } from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";
import type { FutureExecutionSummary } from "./api.js";
import {
	buildProcessBrowserItems,
	DEFAULT_PROCESS_BROWSER_VIEW,
	hasActiveFilters,
	type ProcessBrowserFilterState,
	readProcessBrowserView,
	writeProcessBrowserView,
} from "./process-browser.js";

const defaultFilters: ProcessBrowserFilterState = { status: "all", query: "", processType: "" };

function processItem(overrides: Partial<ProcessOverviewItem> = {}): ProcessBrowseItem {
	return {
		kind: "process",
		item: {
			instanceId: "agt_1",
			processId: "review_process",
			title: "Build navigation",
			subtitle: "review_process · 0 components",
			selectedTurnId: "review",
			lifecycleStatus: "active",
			statusCategory: "active",
			projectCount: 0,
			externalId: null,
			externalLinkCount: 0,
			processDisplayName: "Review",
			processTitle: "Build navigation",
			createdAt: "2026-01-01T10:00:00Z",
			updatedAt: "2026-01-01T11:00:00Z",
			closedAt: null,
			initialPromptPreview: "Search by the launch prompt",
			...overrides,
		},
	};
}

function future(
	overrides: Partial<Extract<FutureExecutionSummary, { kind: "launch" }>> = {},
): ProcessBrowseItem {
	return {
		kind: "future",
		item: {
			id: "fut_1",
			kind: "launch",
			scheduleKind: "once",
			processId: "ticket_issue_process",
			nextRunAt: "2026-01-02T10:00:00Z",
			cronExpression: null,
			instanceId: null,
			title: "Start scheduled work",
			launcherId: "ticket-ui",
			launcherLabel: "Ticket Issue",
			initialPromptPreview: "Implement the scheduled task",
			...overrides,
		},
	};
}

describe("process browser helpers", () => {
	it("projects the server-owned unified page without reordering it", () => {
		const items = buildProcessBrowserItems([
			processItem({
				instanceId: "agt_completed",
				lifecycleStatus: "completed",
				statusCategory: "terminal",
			}),
			future(),
			processItem({ instanceId: "agt_active" }),
			processItem({
				instanceId: "agt_waiting",
				lifecycleStatus: "waiting",
				statusCategory: "waiting",
			}),
		]);

		expect(items.map((item) => [item.id, item.statusFilter])).toEqual([
			["agt_completed", "completed"],
			["fut_1", "scheduled"],
			["agt_active", "running"],
			["agt_waiting", "needs_attention"],
		]);
	});

	it("reports active controls", () => {
		expect(hasActiveFilters(defaultFilters)).toBe(false);
		expect(hasActiveFilters({ ...defaultFilters, query: "history" })).toBe(true);
		expect(hasActiveFilters({ ...defaultFilters, status: "completed" })).toBe(true);
		expect(hasActiveFilters({ ...defaultFilters, processType: "review_process" })).toBe(true);
	});

	it.each([
		null,
		"not-json",
		JSON.stringify({ status: "failed" }),
	])("defaults invalid view preferences", (value) => {
		expect(readProcessBrowserView({ getItem: () => value, setItem: () => undefined })).toEqual(
			DEFAULT_PROCESS_BROWSER_VIEW,
		);
	});

	it("tolerates unavailable preference storage", () => {
		const unavailable = () => {
			throw new Error("blocked");
		};
		const storage = { getItem: unavailable, setItem: unavailable };
		expect(readProcessBrowserView(storage)).toEqual(DEFAULT_PROCESS_BROWSER_VIEW);
		expect(() => writeProcessBrowserView(storage, DEFAULT_PROCESS_BROWSER_VIEW)).not.toThrow();
	});
});

import type { ProcessInstance } from "@leitwerk-dev/domain";
import { createDurableWsFrame } from "@leitwerk-dev/protocol";
import type { ProcessBrowseResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FutureExecutionSummary, ProcessOverviewItem } from "./api.js";
import { EMPTY_PROCESS_BROWSER_STATUS_COUNTS as EMPTY_STATUS_COUNTS } from "./process-browser.js";
import {
	browseItems,
	browseState,
	handleWsEvent,
	loadProcessBrowse,
	setProcessBrowseActive,
} from "./processes.svelte.js";
import type { UiRuntimeTransportConfig } from "./runtime-config.js";

const CONFIG_KEY = Symbol.for("leitwerk.uiRuntimeTransportConfig");
const BROWSE_REFRESH_DELAY_MS = 100;

type GlobalWithConfig = typeof globalThis & {
	[CONFIG_KEY]?: UiRuntimeTransportConfig;
};

let browseResponses: ProcessBrowseResponseBody[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function makeProcess(overrides: Partial<ProcessInstance> = {}): ProcessInstance {
	return {
		id: "agt_1",
		processId: "review_process",
		selectedTurnId: "review",
		lifecycleStatus: "active",
		currentExecution: null,
		planRevision: 0,
		title: "Review API",
		externalId: null,
		externalUrl: null,
		metadata: null,
		defaultModelProfileId: null,
		turnConfigsJson: null,
		selectedTurnModelProfileId: null,
		paramsJson: null,
		stateJson: null,
		createdAt: "2026-01-01T10:00:00Z",
		updatedAt: "2026-01-01T11:00:00Z",
		closedAt: null,
		...overrides,
	};
}

function makeOverview(overrides: Partial<ProcessOverviewItem> = {}): ProcessOverviewItem {
	return {
		instanceId: "agt_1",
		processId: "review_process",
		processDisplayName: "Review",
		processTitle: "Review API",
		title: "Review API",
		subtitle: "review_process · 0 components",
		initialPromptPreview: "Review the API",
		selectedTurnId: "review",
		lifecycleStatus: "active",
		statusCategory: "active",
		projectCount: 0,
		externalId: null,
		externalLinkCount: 0,
		createdAt: "2026-01-01T10:00:00Z",
		updatedAt: "2026-01-01T11:00:00Z",
		closedAt: null,
		...overrides,
	};
}

function makeFuture(overrides: Partial<FutureExecutionSummary> = {}): FutureExecutionSummary {
	return {
		id: "fut_1",
		kind: "launch",
		scheduleKind: "once",
		processId: "review_process",
		instanceId: null,
		nextRunAt: "2026-01-02T10:00:00Z",
		cronExpression: null,
		title: "Scheduled review",
		launcherId: "review-ui",
		launcherLabel: "Review",
		initialPromptPreview: "Review the API",
		...overrides,
	};
}

function makeBrowseResponse(
	overrides: Partial<ProcessBrowseResponseBody> = {},
): ProcessBrowseResponseBody {
	return {
		items: [],
		pagination: {
			limit: 100,
			offset: 0,
			total: 0,
			processTotal: 0,
			futureExecutionTotal: 0,
			hasMore: false,
		},
		facets: {
			statusCounts: EMPTY_STATUS_COUNTS,
			processTypes: [],
		},
		...overrides,
	};
}

function response(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function browseFetches(): string[] {
	return fetchMock.mock.calls
		.map(([input]) => String(input))
		.filter((url) => url.startsWith("/api/processes/browse"));
}

function durableFrame(input: Parameters<typeof createDurableWsFrame>[0]) {
	return createDurableWsFrame({ ...input, sentAt: "2026-01-01T12:00:00Z" });
}

beforeEach(() => {
	vi.useFakeTimers();
	browseResponses = [];
	fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.startsWith("/api/processes/browse")) {
			const next = browseResponses.shift();
			if (!next) throw new Error("Missing queued browse response");
			return response(next);
		}
		if (url === "/api/processes/overview") {
			return response({ processes: [], futureExecutions: [], truncated: false });
		}
		throw new Error(`Unexpected request: ${url}`);
	});
	(globalThis as GlobalWithConfig)[CONFIG_KEY] = { fetchImpl: fetchMock as typeof fetch };
	setProcessBrowseActive(true);
});

afterEach(() => {
	setProcessBrowseActive(false);
	delete (globalThis as GlobalWithConfig)[CONFIG_KEY];
	vi.useRealTimers();
});

describe("active process browse WebSocket refreshes", () => {
	it("refreshes rows, pagination, and facets for process.created", async () => {
		const created = makeOverview({ instanceId: "agt_created", title: "Created review" });
		browseResponses.push(
			makeBrowseResponse(),
			makeBrowseResponse({
				items: [{ kind: "process", item: created }],
				pagination: {
					limit: 100,
					offset: 0,
					total: 1,
					processTotal: 1,
					futureExecutionTotal: 0,
					hasMore: false,
				},
				facets: {
					statusCounts: { ...EMPTY_STATUS_COUNTS, all: 1, running: 1 },
					processTypes: [{ value: "review_process", label: "Review", count: 1 }],
				},
			}),
		);
		const request = { limit: 100, query: "review", status: "running", processType: "" };
		await loadProcessBrowse(request);

		handleWsEvent(
			durableFrame({
				type: "process.created",
				payload: {
					process: makeProcess({ id: "agt_created", title: "Created review" }),
					processId: "review_process",
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(BROWSE_REFRESH_DELAY_MS);

		expect(browseFetches()).toEqual([
			"/api/processes/browse?limit=100&query=review&status=running",
			"/api/processes/browse?limit=100&query=review&status=running",
		]);
		expect(
			get(browseItems).map((entry) =>
				entry.kind === "process" ? entry.item.instanceId : entry.item.id,
			),
		).toEqual(["agt_created"]);
		expect(get(browseState).pagination?.processTotal).toBe(1);
		expect(get(browseState).facets?.statusCounts.running).toBe(1);
	});

	it("removes a row and recomputes facets when process.updated changes filter membership", async () => {
		browseResponses.push(
			makeBrowseResponse({
				items: [{ kind: "process", item: makeOverview() }],
				pagination: {
					limit: 100,
					offset: 0,
					total: 1,
					processTotal: 1,
					futureExecutionTotal: 0,
					hasMore: false,
				},
				facets: {
					statusCounts: { ...EMPTY_STATUS_COUNTS, all: 1, running: 1 },
					processTypes: [{ value: "review_process", label: "Review", count: 1 }],
				},
			}),
			makeBrowseResponse({
				facets: {
					statusCounts: { ...EMPTY_STATUS_COUNTS, all: 1, completed: 1 },
					processTypes: [],
				},
			}),
		);
		await loadProcessBrowse({ limit: 100, status: "running" });

		handleWsEvent(
			durableFrame({
				type: "process.updated",
				instanceId: "agt_1",
				payload: {
					process: {
						lifecycleStatus: "completed",
						closedAt: "2026-01-01T12:00:00Z",
					},
					changedFields: ["lifecycleStatus", "closedAt"],
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(BROWSE_REFRESH_DELAY_MS);

		expect(get(browseItems)).toEqual([]);
		expect(get(browseState).pagination?.processTotal).toBe(0);
		expect(get(browseState).facets?.statusCounts.completed).toBe(1);
	});

	it("refreshes future rows and totals for future.updated", async () => {
		browseResponses.push(
			makeBrowseResponse({
				items: [{ kind: "future", item: makeFuture() }],
				pagination: {
					limit: 100,
					offset: 0,
					total: 1,
					processTotal: 0,
					futureExecutionTotal: 1,
					hasMore: false,
				},
				facets: {
					statusCounts: { ...EMPTY_STATUS_COUNTS, all: 1, scheduled: 1 },
					processTypes: [{ value: "review_process", label: "Review", count: 1 }],
				},
			}),
			makeBrowseResponse(),
		);
		await loadProcessBrowse({ limit: 100, status: "scheduled" });

		handleWsEvent(
			durableFrame({
				type: "future.updated",
				payload: {
					futureExecutionId: "fut_1",
					operation: "deleted",
					kind: "launch",
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(BROWSE_REFRESH_DELAY_MS);

		expect(get(browseItems)).toEqual([]);
		expect(get(browseState).pagination?.futureExecutionTotal).toBe(0);
		expect(get(browseState).facets?.statusCounts.scheduled).toBe(0);
	});

	it("does not refresh browse data after the route becomes inactive", async () => {
		browseResponses.push(makeBrowseResponse());
		await loadProcessBrowse({ limit: 100 });
		setProcessBrowseActive(false);

		handleWsEvent(
			durableFrame({
				type: "process.updated",
				instanceId: "agt_1",
				payload: { process: { updatedAt: "2026-01-01T12:00:00Z" } },
			}),
		);
		await vi.advanceTimersByTimeAsync(BROWSE_REFRESH_DELAY_MS);

		expect(browseFetches()).toHaveLength(1);
	});
});

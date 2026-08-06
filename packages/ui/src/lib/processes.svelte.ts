import { projectFutureExecutionOverview, type WsFrame } from "@leitwerk-dev/protocol";
import { derived, get, writable } from "svelte/store";
import {
	type FullFutureExecution,
	type FutureExecutionSummary,
	fetchProcessBrowse,
	fetchProcessDetail,
	fetchProcessesList,
	type ProcessBrowseFacets,
	type ProcessBrowseItem,
	type ProcessBrowsePagination,
	type ProcessBrowseRequest,
	type ProcessDetailData,
	type ProcessOverviewItem,
} from "./api";
import { upsertFutureExecutionSummary } from "./future-executions-logic.js";
import { applyPrimaryPathFrame } from "./primary-path-detail.js";
import { replayPrimaryPathFramesAfterSnapshot } from "./primary-path-replay.js";
import { buildProcessRowView, sortProcessRowViews } from "./process-row-view.js";
import { classifyWsEvent, createRequestGuard, type WsAction } from "./processes-logic.js";

const listItems = writable<ProcessOverviewItem[]>([]);
export const futureExecutions = writable<FutureExecutionSummary[]>([]);
export const processRows = derived(listItems, (items) =>
	sortProcessRowViews(items.map((item) => buildProcessRowView(item))),
);

export const listState = writable({
	loading: false,
	error: null as string | null,
});

export const browseItems = writable<ProcessBrowseItem[]>([]);
export const browseState = writable({
	loading: false,
	error: null as string | null,
	pagination: null as ProcessBrowsePagination | null,
	facets: null as ProcessBrowseFacets | null,
});

export const detailState = writable({
	data: null as ProcessDetailData | null,
	loading: false,
	error: null as string | null,
	loadedAtMs: 0,
});

const PROCESS_BROWSE_WS_REFRESH_DELAY_MS = 100;

let browseActive = false;
let activeBrowseRequest: ProcessBrowseRequest | null = null;
let scheduledListReloadTimer: ReturnType<typeof setTimeout> | null = null;
let scheduledBrowseReloadTimer: ReturnType<typeof setTimeout> | null = null;
let detailInstanceId: string | null = null;
let scheduledDetailReloadTimer: ReturnType<typeof setTimeout> | null = null;
const pendingPrimaryPathFramesByInstanceId = new Map<
	string,
	Array<Extract<WsAction, { kind: "apply_primary_path_frame" }>["frame"]>
>();

const listGuard = createRequestGuard();
const browseGuard = createRequestGuard();
const detailGuard = createRequestGuard();

function scheduleProcessesListReload(delayMs = PROCESS_BROWSE_WS_REFRESH_DELAY_MS) {
	if (scheduledListReloadTimer) clearTimeout(scheduledListReloadTimer);
	scheduledListReloadTimer = setTimeout(() => {
		scheduledListReloadTimer = null;
		void loadProcessesList();
	}, delayMs);
}

function clearScheduledBrowseReload() {
	if (!scheduledBrowseReloadTimer) {
		return;
	}
	clearTimeout(scheduledBrowseReloadTimer);
	scheduledBrowseReloadTimer = null;
}

export function setProcessBrowseActive(active: boolean) {
	browseActive = active;
	if (!active) {
		clearScheduledBrowseReload();
		activeBrowseRequest = null;
	}
}

function clearScheduledDetailReload() {
	if (!scheduledDetailReloadTimer) {
		return;
	}
	clearTimeout(scheduledDetailReloadTimer);
	scheduledDetailReloadTimer = null;
}

function clearPendingPrimaryPathFrames(instanceId?: string) {
	if (typeof instanceId === "string") {
		pendingPrimaryPathFramesByInstanceId.delete(instanceId);
		return;
	}
	pendingPrimaryPathFramesByInstanceId.clear();
}

function bufferPrimaryPathFrame(action: Extract<WsAction, { kind: "apply_primary_path_frame" }>) {
	const queuedFrames = pendingPrimaryPathFramesByInstanceId.get(action.instanceId) ?? [];
	queuedFrames.push(action.frame);
	pendingPrimaryPathFramesByInstanceId.set(action.instanceId, queuedFrames.slice(-500));
}

function takePendingPrimaryPathFrames(instanceId: string) {
	const queuedFrames = pendingPrimaryPathFramesByInstanceId.get(instanceId) ?? [];
	pendingPrimaryPathFramesByInstanceId.delete(instanceId);
	return queuedFrames;
}

function applyPrimaryPathFrameToDetailData(
	data: ProcessDetailData,
	action: Extract<WsAction, { kind: "apply_primary_path_frame" }>,
): ProcessDetailData {
	const nextData = {
		...data,
		primaryPath: applyPrimaryPathFrame(data.primaryPath, action.frame),
	};
	return nextData;
}

export function setCurrentDetailInstanceId(instanceId: string | null) {
	if (detailInstanceId === instanceId) {
		return;
	}
	if (detailInstanceId) {
		clearPendingPrimaryPathFrames(detailInstanceId);
	}
	detailInstanceId = instanceId;
	if (!instanceId) {
		clearScheduledDetailReload();
	}
}

export function upsertFutureExecution(item: FutureExecutionSummary | FullFutureExecution) {
	futureExecutions.update((items) =>
		upsertFutureExecutionSummary(
			items,
			"initialPromptPreview" in item ? item : projectFutureExecutionOverview(item),
		),
	);
}

export async function loadProcessesList() {
	const gen = listGuard.next();
	listState.update((state) => ({ ...state, loading: true, error: null }));
	try {
		const result = await fetchProcessesList();
		if (listGuard.isStale(gen)) return;
		listItems.set(result.processes);
		futureExecutions.set(result.futureExecutions);
	} catch (err) {
		if (listGuard.isStale(gen)) return;
		listState.update((state) => ({
			...state,
			error: err instanceof Error ? err.message : "Couldn't load the process list",
		}));
	} finally {
		if (!listGuard.isStale(gen)) {
			listState.update((state) => ({ ...state, loading: false }));
		}
	}
}

function mergeUniqueBy<T>(
	items: readonly T[],
	incoming: readonly T[],
	key: (item: T) => string,
): T[] {
	return [...new Map([...items, ...incoming].map((item) => [key(item), item])).values()];
}

export async function loadProcessBrowse(
	request: ProcessBrowseRequest = {},
	options: { append?: boolean } = {},
) {
	if (!options.append) {
		clearScheduledBrowseReload();
		activeBrowseRequest = { ...request };
		delete activeBrowseRequest.offset;
	}
	const gen = browseGuard.next();
	browseState.update((state) => ({ ...state, loading: true, error: null }));
	try {
		const result = await fetchProcessBrowse(request);
		if (browseGuard.isStale(gen)) return;
		if (options.append) {
			browseItems.update((items) =>
				mergeUniqueBy(items, result.items, (entry) =>
					entry.kind === "process" ? `process:${entry.item.instanceId}` : `future:${entry.item.id}`,
				),
			);
		} else {
			browseItems.set(result.items);
		}
		browseState.set({
			loading: false,
			error: null,
			pagination: result.pagination,
			facets: result.facets,
		});
	} catch (err) {
		if (browseGuard.isStale(gen)) return;
		browseState.update((state) => ({
			...state,
			error: err instanceof Error ? err.message : "Couldn't browse processes",
		}));
	} finally {
		if (!browseGuard.isStale(gen)) {
			browseState.update((state) => ({ ...state, loading: false }));
		}
	}
}

function scheduleActiveProcessBrowseReload(delayMs = PROCESS_BROWSE_WS_REFRESH_DELAY_MS) {
	if (!browseActive || !activeBrowseRequest) {
		return;
	}
	clearScheduledBrowseReload();
	scheduledBrowseReloadTimer = setTimeout(() => {
		scheduledBrowseReloadTimer = null;
		if (!browseActive || !activeBrowseRequest) {
			return;
		}
		void loadProcessBrowse(activeBrowseRequest);
	}, delayMs);
}

export async function loadProcessDetail(instanceId: string) {
	clearScheduledDetailReload();
	const gen = detailGuard.next();
	setCurrentDetailInstanceId(instanceId);
	detailState.update((state) => ({ ...state, loading: true, error: null }));
	try {
		const result = await fetchProcessDetail(instanceId);
		if (detailGuard.isStale(gen)) return;
		const loadedAtMs = Date.now();
		const replayedPrimaryPath = replayPrimaryPathFramesAfterSnapshot(
			result.primaryPath,
			takePendingPrimaryPathFrames(instanceId),
		);
		detailState.set({
			data: {
				...result,
				primaryPath: replayedPrimaryPath,
			},
			loading: false,
			error: null,
			loadedAtMs,
		});
	} catch (err) {
		if (detailGuard.isStale(gen)) return;
		detailState.update((state) => ({
			...state,
			error: err instanceof Error ? err.message : "Couldn't load this process",
			loading: false,
		}));
	}
}

function scheduleLoadProcessDetail(instanceId: string, delayMs = 120) {
	if (detailInstanceId !== instanceId) {
		return;
	}
	clearScheduledDetailReload();
	scheduledDetailReloadTimer = setTimeout(() => {
		scheduledDetailReloadTimer = null;
		void loadProcessDetail(instanceId);
	}, delayMs);
}

export function clearDetail() {
	clearScheduledDetailReload();
	detailState.set({
		data: null,
		loading: false,
		error: null,
		loadedAtMs: 0,
	});
	detailGuard.invalidate();
}

function executePrimaryPathFrame(action: WsAction & { kind: "apply_primary_path_frame" }) {
	const current = get(detailState);
	if (detailInstanceId === action.instanceId && current.data?.process.id !== action.instanceId) {
		bufferPrimaryPathFrame(action);
		return;
	}
	if (current.data?.process.id !== action.instanceId) {
		return;
	}
	detailState.set({
		...current,
		data: applyPrimaryPathFrameToDetailData(current.data, action),
	});
}

export function handleWsEvent(frame: WsFrame) {
	const actions = classifyWsEvent(frame, detailInstanceId);

	for (const action of actions) {
		switch (action.kind) {
			case "reload_list":
				scheduleProcessesListReload();
				break;
			case "refresh_active_browse":
				scheduleActiveProcessBrowseReload();
				break;
			case "reload_detail":
				scheduleLoadProcessDetail(action.instanceId);
				break;
			case "remove_deleted_detail":
				if (detailInstanceId === action.instanceId) {
					clearPendingPrimaryPathFrames(action.instanceId);
					clearDetail();
					void import("./router.svelte.js").then(({ buildProcessesPath, navigate }) => {
						navigate(buildProcessesPath(), { replace: true });
					});
				}
				break;
			case "apply_primary_path_frame":
				executePrimaryPathFrame(action);
				break;
			case "ignored":
				break;
		}
	}
}

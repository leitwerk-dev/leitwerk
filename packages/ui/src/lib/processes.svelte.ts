import {
	projectFutureExecutionOverview,
	WS_PRIMARY_PATH_TYPES,
	type WsFrame,
} from "@leitwerk-dev/protocol";
import type {
	ProcessBrowseFacets,
	ProcessBrowseItem,
	ProcessBrowsePagination,
	ProcessOverviewItem,
} from "@leitwerk-dev/protocol/http-contracts";
import { derived, get, writable } from "svelte/store";
import {
	type FullFutureExecution,
	type FutureExecutionSummary,
	fetchProcessBrowse,
	fetchProcessDetail,
	fetchProcessesList,
	type ProcessBrowseRequest,
	type ProcessDetailData,
} from "./api";
import { upsertFutureExecutionSummary } from "./future-executions-logic.js";
import { applyPrimaryPathFrame, isFullPrimaryPathDetailFrame } from "./primary-path-detail.js";
import { replayPrimaryPathFramesAfterSnapshot } from "./primary-path-replay.js";
import { mergeProcessHistory, mergeUniqueBy } from "./process-history.js";
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

function createReloadScheduler() {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return {
		clear() {
			if (timer) clearTimeout(timer);
			timer = null;
		},
		schedule(reload: () => void, delayMs: number) {
			this.clear();
			timer = setTimeout(() => {
				timer = null;
				reload();
			}, delayMs);
		},
	};
}

let browseActive = false;
let activeBrowseRequest: ProcessBrowseRequest | null = null;
const listReload = createReloadScheduler();
const browseReload = createReloadScheduler();
let detailInstanceId: string | null = null;
const detailReload = createReloadScheduler();
const pendingPrimaryPathFramesByInstanceId = new Map<
	string,
	Array<Extract<WsAction, { kind: "apply_primary_path_frame" }>["frame"]>
>();

const listGuard = createRequestGuard();
const browseGuard = createRequestGuard();
const detailGuard = createRequestGuard();
const historyGuard = createRequestGuard();
export const historyState = writable({ loading: false, error: null as string | null });

export async function loadEarlierProcessHistory() {
	const current = get(detailState).data;
	const before = current?.timeline.history?.beforeTurnRecordId;
	if (!current || !before || get(historyState).loading) return;
	const generation = historyGuard.next();
	historyState.set({ loading: true, error: null });
	try {
		const older = await fetchProcessDetail(current.process.id, before);
		if (historyGuard.isStale(generation)) return;
		detailState.update((state) =>
			state.data?.process.id === current.process.id
				? { ...state, data: mergeProcessHistory(state.data, older) }
				: state,
		);
		historyState.set({ loading: false, error: null });
	} catch (error) {
		if (historyGuard.isStale(generation)) return;
		historyState.set({
			loading: false,
			error: error instanceof Error ? error.message : "Couldn't load earlier steps",
		});
	}
}

export function setProcessBrowseActive(active: boolean) {
	browseActive = active;
	if (!active) {
		browseReload.clear();
		activeBrowseRequest = null;
	}
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
	if (action.frame.type === WS_PRIMARY_PATH_TYPES.SUMMARY_UPDATED) {
		// Summaries replace earlier summaries, so buffering a slow page request stays bounded.
		const id = action.frame.payload.turnRecordId;
		const prior = queuedFrames.findIndex(
			(frame) =>
				frame.type === WS_PRIMARY_PATH_TYPES.SUMMARY_UPDATED && frame.payload.turnRecordId === id,
		);
		if (prior >= 0) queuedFrames.splice(prior, 1);
	}
	queuedFrames.push(action.frame);
	pendingPrimaryPathFramesByInstanceId.set(action.instanceId, queuedFrames);
}

function takePendingPrimaryPathFrames(instanceId: string) {
	const queuedFrames = pendingPrimaryPathFramesByInstanceId.get(instanceId) ?? [];
	pendingPrimaryPathFramesByInstanceId.delete(instanceId);
	return queuedFrames;
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
		detailReload.clear();
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

export async function loadProcessBrowse(
	request: ProcessBrowseRequest = {},
	options: { append?: boolean } = {},
) {
	if (!options.append) {
		browseReload.clear();
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
	if (!browseActive || !activeBrowseRequest) return;
	browseReload.schedule(() => {
		if (browseActive && activeBrowseRequest) void loadProcessBrowse(activeBrowseRequest);
	}, delayMs);
}

export async function loadProcessDetail(instanceId: string) {
	detailReload.clear();
	const gen = detailGuard.next();
	setCurrentDetailInstanceId(instanceId);
	detailState.update((state) => ({ ...state, loading: true, error: null }));
	try {
		const result = await fetchProcessDetail(instanceId);
		if (detailGuard.isStale(gen)) return;
		const loadedAtMs = Date.now();
		const previous = get(detailState).data;
		const retained =
			previous?.process.id === instanceId &&
			previous.timeline.history &&
			previous.timeline.turns.some((turn) => turn.id === result.timeline.turns[0]?.id)
				? mergeProcessHistory(result, previous)
				: result;
		const replayedPrimaryPath = replayPrimaryPathFramesAfterSnapshot(
			result.primaryPath,
			takePendingPrimaryPathFrames(instanceId),
		);
		detailState.set({
			data: {
				...retained,
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
	if (detailInstanceId === instanceId)
		detailReload.schedule(() => void loadProcessDetail(instanceId), delayMs);
}

export function clearDetail() {
	historyGuard.invalidate();
	historyState.set({ loading: false, error: null });
	setCurrentDetailInstanceId(null);
	clearPendingPrimaryPathFrames();
	detailReload.clear();
	detailState.set({
		data: null,
		loading: false,
		error: null,
		loadedAtMs: 0,
	});
	detailGuard.invalidate();
}

const reasoningFrameListeners = new Set<(frame: WsFrame) => void>();
export function subscribeReasoningFrames(listener: (frame: WsFrame) => void) {
	reasoningFrameListeners.add(listener);
	return () => {
		reasoningFrameListeners.delete(listener);
	};
}

function executePrimaryPathFrame(action: WsAction & { kind: "apply_primary_path_frame" }) {
	const current = get(detailState);
	if (isFullPrimaryPathDetailFrame(action.frame)) return;
	if (detailInstanceId === action.instanceId && current.loading) bufferPrimaryPathFrame(action);
	if (current.data?.process.id !== action.instanceId) {
		return;
	}
	detailState.set({
		...current,
		data: {
			...current.data,
			primaryPath: applyPrimaryPathFrame(current.data.primaryPath, action.frame),
		},
	});
}

export function handleWsEvent(frame: WsFrame) {
	for (const listener of reasoningFrameListeners) listener(frame);
	const actions = classifyWsEvent(frame, detailInstanceId);

	for (const action of actions) {
		switch (action.kind) {
			case "reload_list":
				listReload.schedule(() => void loadProcessesList(), PROCESS_BROWSE_WS_REFRESH_DELAY_MS);
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

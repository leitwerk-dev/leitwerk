import { get } from "svelte/store";
import { afterEach, expect, it, vi } from "vitest";
import type { ProcessDetailData } from "./api.js";
import { mergeProcessHistory } from "./process-history.js";
import {
	clearDetail,
	detailState,
	historyState,
	loadEarlierProcessHistory,
	loadProcessDetail,
} from "./processes.svelte.js";
import type { UiRuntimeTransportConfig } from "./runtime-config.js";

const CONFIG_KEY = Symbol.for("leitwerk.uiRuntimeTransportConfig");
type GlobalWithConfig = typeof globalThis & { [CONFIG_KEY]?: UiRuntimeTransportConfig };

function snapshot(id: string, turns: string[], before: string | null): ProcessDetailData {
	return {
		process: { id, lifecycleStatus: "waiting" },
		timeline: {
			turns: turns.map((id) => ({ id, startedAt: id, status: "completed" })),
			history: { beforeTurnRecordId: before },
			inputs: [],
			tracePreviewsByTurnRecordId: {},
		},
		primaryPath: {
			instanceId: id,
			throughEventSequence: 0,
			entriesOmitted: true,
			turnState: { activeTurn: null },
		},
		leafOutcomeSnapshots: [],
		questionRequests: [],
		toolApprovalRequests: [],
		instanceTree: { nodes: [], edges: [] },
		startup: { attempts: [], workerStarts: [] },
	} as unknown as ProcessDetailData;
}

afterEach(() => {
	clearDetail();
	delete (globalThis as GlobalWithConfig)[CONFIG_KEY];
});

it("keeps live state and newer records when older history arrives", () => {
	const live = snapshot("a", ["02", "03"], "02");
	live.process.lifecycleStatus = "active";
	const older = snapshot("a", ["01", "02"], null);
	older.timeline.turns[1].status = "in_progress";
	older.timeline.turns.push({
		...older.timeline.turns[1],
		id: "current:previous_step",
	});
	const merged = mergeProcessHistory(live, older);
	expect(merged.process.lifecycleStatus).toBe("active");
	expect(merged.timeline.turns.map((t) => t.id)).toEqual(["01", "02", "03"]);
	expect(merged.timeline.turns[1].status).toBe("completed");
	expect(merged.timeline.history?.beforeTurnRecordId).toBeNull();
});

it("discards a delayed history response after switching processes and permits retry after failure", async () => {
	const pending = Promise.withResolvers<Response>();
	const fetch = vi.fn(async (url: string) => {
		if (url.includes("beforeTurnRecordId")) return pending.promise;
		return Response.json(snapshot(url.includes("/a/") ? "a" : "b", ["02"], "02"));
	});
	(globalThis as GlobalWithConfig)[CONFIG_KEY] = { fetchImpl: fetch as typeof globalThis.fetch };
	await loadProcessDetail("a");
	expect(get(detailState).error).toBeNull();
	const earlier = loadEarlierProcessHistory();
	expect(get(historyState).loading).toBe(true);
	clearDetail();
	await loadProcessDetail("b");
	pending.resolve(Response.json(snapshot("a", ["01"], null)));
	await earlier;
	expect(get(detailState).data?.process.id).toBe("b");
	expect(get(detailState).data?.timeline.turns.map((t) => t.id)).toEqual(["02"]);
	fetch.mockImplementationOnce(async () => {
		throw new Error("offline");
	});
	await loadEarlierProcessHistory();
	expect(get(historyState).error).toBe("offline");
	expect(get(detailState).data?.process.id).toBe("b");
	fetch.mockImplementationOnce(async () => Response.json(snapshot("b", ["01"], null)));
	await loadEarlierProcessHistory();
	expect(get(historyState).error).toBeNull();
	expect(get(detailState).data?.timeline.turns.map((t) => t.id)).toEqual(["01", "02"]);
});

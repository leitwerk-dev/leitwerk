import type { ExecutionInspectionSummary } from "@leitwerk-dev/protocol";
import { onDestroy, tick, untrack } from "svelte";
import { fetchExecutionInspection, type InspectionSections } from "../../../lib/api.js";
import { subscribeReasoningFrames } from "../../../lib/processes.svelte.js";
import { ReasoningHistory } from "../../../lib/reasoning-history.js";
import type { InspectorRoute } from "../../../lib/router-logic.js";

class InspectionData {
	summary = $state.raw<ExecutionInspectionSummary | null>(null);
	summaryError = $state<string | null>(null);
	expanded = $state.raw<Partial<InspectionSections>>({});
	error = $state<string | null>(null);
	loading = $state(false);
	loadedTraceTarget = $state("");
	live = $state.raw<ReturnType<ReasoningHistory["snapshot"]> | null>(null);
	activity = $state(0);
}

export function createInspectionData(args: {
	get instanceId(): string;
	get target(): NonNullable<InspectorRoute>;
	get refreshKey(): string;
	ready(): void;
}) {
	const data = new InspectionData();
	let selected = "";
	let controller: AbortController | null = null;
	let history: ReasoningHistory | null = null;
	const unsubscribe = subscribeReasoningFrames((frame) => {
		if (args.target.scope !== "execution" || args.target.section !== "trace" || !history) return;
		const next = history.push(frame);
		if (next) {
			data.live = next;
			data.activity++;
		}
	});
	async function load() {
		controller?.abort();
		const target = args.target;
		if (target.scope !== "execution") return;
		const targetKey = JSON.stringify(target);
		const instanceId = args.instanceId;
		const key = `${instanceId}/${target.turnRecordId}`;
		const abort = new AbortController();
		controller = abort;
		if (selected !== key) {
			selected = key;
			data.summary = null;
			data.summaryError = null;
			data.expanded = {};
			data.live = null;
			data.activity = 0;
			history = new ReasoningHistory(instanceId, target.turnRecordId);
		}
		data.error = null;
		data.loading = true;
		if (target.section === "trace") history?.beginRequest();
		await tick();
		if (abort.signal.aborted) return;
		void fetchExecutionInspection(instanceId, target.turnRecordId, "summary", {}, abort.signal)
			.then((value) => {
				if (!abort.signal.aborted) {
					data.summary = value;
					data.summaryError = null;
				}
			})
			.catch((cause) => {
				if (!abort.signal.aborted) data.summaryError = cause.message;
			});
		try {
			const value = await fetchExecutionInspection(
				instanceId,
				target.turnRecordId,
				target.section,
				target,
				abort.signal,
			);
			if (abort.signal.aborted) return;
			data.expanded = { ...data.expanded, [target.section]: value };
			if (target.section === "trace" && "reasoning" in value && history) {
				data.live = history.accept(value);
				data.loadedTraceTarget = targetKey;
			}
			data.loading = false;
			await tick();
			if (!abort.signal.aborted && target.section !== "trace") args.ready();
		} catch (cause) {
			if (abort.signal.aborted) return;
			history?.failedRequest();
			data.loading = false;
			data.error = cause instanceof Error ? cause.message : "Couldn't load execution evidence";
		}
	}
	$effect(() => {
		args.target;
		args.instanceId;
		args.refreshKey;
		untrack(() => {
			void load();
		});
	});
	onDestroy(() => {
		controller?.abort();
		unsubscribe();
	});
	return Object.assign(data, { retry: load });
}

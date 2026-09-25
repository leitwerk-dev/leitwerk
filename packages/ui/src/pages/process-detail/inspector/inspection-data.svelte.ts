import type { ProcessEvent } from "@leitwerk-dev/domain";
import type { ExecutionInspectionSummary, TurnTraceSnapshot } from "@leitwerk-dev/protocol";
import { onDestroy, tick, untrack } from "svelte";
import { fetchExecutionInspection, type InspectionSections } from "../../../lib/api.js";
import { subscribeReasoningFrames } from "../../../lib/processes.svelte.js";
import { ReasoningHistory } from "../../../lib/reasoning-history.js";
import type { InspectorRoute } from "../../../lib/router-logic.js";

export function createInspectionData(args: {
	get instanceId(): string;
	get target(): NonNullable<InspectorRoute>;
	get refreshKey(): string;
	ready(): void;
}) {
	let summary = $state.raw<ExecutionInspectionSummary | null>(null);
	let summaryError = $state<string | null>(null);
	let expanded = $state.raw<Partial<InspectionSections>>({});
	let error = $state<string | null>(null);
	let loading = $state(false);
	let live = $state.raw<TurnTraceSnapshot | null>(null);
	let events = $state.raw<ProcessEvent[]>([]);
	let activity = $state(0);
	let generation = 0;
	let selected = "";
	let controller: AbortController | null = null;
	let history: ReasoningHistory | null = null;
	const unsubscribe = subscribeReasoningFrames((frame) => {
		if (args.target.scope !== "execution" || args.target.section !== "trace" || !history) return;
		const next = history.push(frame);
		if (next) {
			live = next;
			events = history.events();
			activity++;
		}
	});
	async function load() {
		const target = args.target;
		if (target.scope !== "execution") {
			controller?.abort();
			generation++;
			return;
		}
		const instanceId = args.instanceId;
		const key = `${instanceId}/${target.turnRecordId}`;
		controller?.abort();
		const abort = new AbortController();
		controller = abort;
		const request = ++generation;
		if (selected !== key) {
			selected = key;
			summary = null;
			summaryError = null;
			expanded = {};
			live = null;
			events = [];
			activity = 0;
			history = new ReasoningHistory(instanceId, target.turnRecordId);
		}
		error = null;
		loading = true;
		const current = () => !abort.signal.aborted && request === generation;
		if (target.section === "trace") history?.beginRequest();
		await tick();
		if (!current()) return;
		void fetchExecutionInspection(instanceId, target.turnRecordId, "summary", {}, abort.signal)
			.then((value) => {
				if (current()) {
					summary = value;
					summaryError = null;
				}
			})
			.catch((cause) => {
				if (current()) summaryError = cause.message;
			});
		try {
			const value = await fetchExecutionInspection(
				instanceId,
				target.turnRecordId,
				target.section,
				target,
				abort.signal,
			);
			if (!current()) return;
			expanded = { ...expanded, [target.section]: value };
			if (target.section === "trace" && "reasoning" in value && history) {
				live = history.accept(value);
				events = history.events();
			}
			loading = false;
			await tick();
			if (current()) args.ready();
		} catch (cause) {
			if (!current()) return;
			history?.failedRequest();
			loading = false;
			error = cause instanceof Error ? cause.message : "Couldn't load execution evidence";
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
		generation++;
		unsubscribe();
	});
	return {
		get summary() {
			return summary;
		},
		get summaryError() {
			return summaryError;
		},
		get expanded() {
			return expanded;
		},
		get error() {
			return error;
		},
		get loading() {
			return loading;
		},
		get live() {
			return live;
		},
		get events() {
			return events;
		},
		get activity() {
			return activity;
		},
		retry: load,
	};
}

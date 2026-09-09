import type {
	ProcessLifecycleEffects,
	ServerProcessContext,
	ServerTransitionRequest,
} from "@leitwerk-dev/process-sdk";
import type { QueuedProcessInput } from "../../process-input-dispatch.js";
import {
	resolveProductTurnResultMarkdown,
	resolveSemanticTurnResultMarkdown,
	type TurnRecordMarkdownLookup,
} from "../../turn-result-markdown.js";
import {
	createDeferredExtensionEvent,
	type DeferredProcessExtensionEvent,
} from "./deferred-extension-events.js";

export function createProcessPlanCollector<TParams, TState>(
	input: Pick<
		ServerProcessContext<TParams, TState>,
		"process" | "projects" | "params" | "state"
	> & {
		turnRecords: TurnRecordMarkdownLookup;
	},
) {
	const queuedInputs: QueuedProcessInput[] = [];
	const emittedEvents: DeferredProcessExtensionEvent[] = [];
	const lifecycleEffects: ProcessLifecycleEffects[] = [];
	let transitionRequest: ServerTransitionRequest<TState> | null = null;
	const context: ServerProcessContext<TParams, TState> = {
		process: input.process,
		projects: input.projects,
		params: input.params,
		state: input.state,
		async transition(next) {
			transitionRequest = next;
		},
		emitEvent(eventType, data) {
			emittedEvents.push(createDeferredExtensionEvent(input.process.id, eventType, data));
		},
		readSemanticTurnResultMarkdown(ref) {
			return resolveSemanticTurnResultMarkdown({
				process: input.process,
				semanticEntryRefKey: ref,
				turnRecords: input.turnRecords,
				required: false,
			});
		},
		readProductTurnResultMarkdown(productName) {
			return resolveProductTurnResultMarkdown({
				process: input.process,
				productName,
				turnRecords: input.turnRecords,
				required: false,
			});
		},
		queueInput(queued) {
			queuedInputs.push({
				source: queued.source,
				kind: queued.kind,
				target: queued.target ?? null,
				bodyMarkdown: queued.bodyMarkdown,
			});
		},
		applyLifecycleEffects(effects) {
			lifecycleEffects.push(effects);
		},
	};
	return {
		context,
		queuedInputs,
		emittedEvents,
		lifecycleEffects,
		get transitionRequest() {
			return transitionRequest;
		},
	};
}

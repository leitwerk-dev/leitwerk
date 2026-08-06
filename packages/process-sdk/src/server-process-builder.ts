import type {
	ProcessActionDefinition,
	ProcessCleanupHandler,
	ProcessTurnOutcomeEvent,
	ServerProcessAPI,
	ServerProcessContext,
} from "./extension-api.js";
import { cloneArrayValueMap, cloneMap, registerUnique } from "./registry-utils.js";
import {
	validateProcessActionPreviewDefinition,
	validateProcessActionSchedulingDefinition,
} from "./turn-semantics.js";

export type ServerTurnOutcomeHandler<TParams = unknown, TState = unknown> = (
	event: ProcessTurnOutcomeEvent,
	ctx: ServerProcessContext<TParams, TState>,
) => void | Promise<void>;

export interface BuiltServerProcessDefinition<TParams = unknown, TState = unknown> {
	actions: ReadonlyMap<string, ProcessActionDefinition<TParams, TState>>;
	turnOutcomeHandlers: ReadonlyMap<string, readonly ServerTurnOutcomeHandler<TParams, TState>[]>;
	cleanupHandlers: readonly ProcessCleanupHandler<TParams, TState>[];
}

export function createServerProcessBuilder<TParams = unknown, TState = unknown>(): ServerProcessAPI<
	TParams,
	TState
> & { getDefinition(): BuiltServerProcessDefinition<TParams, TState> } {
	const actions = new Map<string, ProcessActionDefinition<TParams, TState>>();
	const turnOutcomeHandlers = new Map<string, ServerTurnOutcomeHandler<TParams, TState>[]>();
	const cleanupHandlers: ProcessCleanupHandler<TParams, TState>[] = [];
	return {
		action(def) {
			registerUnique(actions, def.id, def, {
				duplicateMessage: `Process action '${def.id}' is already registered`,
				validate: (value) => {
					if (!value.plan && !value.execute) {
						throw new Error(
							`Process action '${value.id}' must declare plan(...) or side-effect execute(...)`,
						);
					}
					if (value.execute && !value.plan && value.executionMode !== "side_effect") {
						throw new Error(
							`Process action '${value.id}' with execute(...) must set executionMode: "side_effect"`,
						);
					}
					if (value.executionMode === "side_effect" && !value.execute) {
						throw new Error(
							`Process action '${value.id}' with executionMode: "side_effect" must declare execute(...)`,
						);
					}
					if (value.executionMode === "side_effect" && value.scheduling) {
						throw new Error(
							`Process action '${value.id}' with executionMode: "side_effect" cannot declare scheduling metadata`,
						);
					}
					const previewErrors = validateProcessActionPreviewDefinition(
						value.preview,
						`Process action '${value.id}' preview`,
					);
					if (previewErrors.length > 0) {
						throw new Error(previewErrors.join("; "));
					}
					const schedulingErrors = validateProcessActionSchedulingDefinition(
						value.scheduling,
						`Process action '${value.id}' scheduling`,
					);
					if (schedulingErrors.length > 0) {
						throw new Error(schedulingErrors.join("; "));
					}
				},
			});
		},
		onTurnOutcome(turnId, handler) {
			const handlers = turnOutcomeHandlers.get(turnId) ?? [];
			handlers.push(handler);
			turnOutcomeHandlers.set(turnId, handlers);
		},
		onCleanup(handler) {
			cleanupHandlers.push(handler);
		},
		getDefinition() {
			return {
				actions: cloneMap(actions),
				turnOutcomeHandlers: cloneArrayValueMap(turnOutcomeHandlers),
				cleanupHandlers: [...cleanupHandlers],
			};
		},
	};
}

import type { TurnId } from "@leitwerk-dev/domain";
import type { WorkerProcessAPI, WorkerTurnHandler } from "./extension-api.js";
import { cloneMap, registerUnique } from "./registry-utils.js";

export interface BuiltWorkerProcessDefinition<TParams = unknown, TState = unknown> {
	startTurnId: TurnId | null;
	turns: ReadonlyMap<TurnId, WorkerTurnHandler<TParams, TState>>;
}

export function createWorkerProcessBuilder<TParams = unknown, TState = unknown>(): WorkerProcessAPI<
	TParams,
	TState
> & { getDefinition(): BuiltWorkerProcessDefinition<TParams, TState> } {
	const turns = new Map<TurnId, WorkerTurnHandler<TParams, TState>>();
	let startTurnId: TurnId | null = null;

	return {
		start(turnId: TurnId): void {
			startTurnId = turnId;
		},
		turn(turnId: TurnId, handler: WorkerTurnHandler<TParams, TState>): void {
			registerUnique(turns, turnId, handler, {
				duplicateMessage: `Worker turn '${turnId}' is already registered`,
			});
		},
		getDefinition(): BuiltWorkerProcessDefinition<TParams, TState> {
			return {
				startTurnId,
				turns: cloneMap(turns),
			};
		},
	};
}

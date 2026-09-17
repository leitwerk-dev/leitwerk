import type { TurnId } from "@leitwerk-dev/domain";
import type { WorkerProcessAPI, WorkerTurnHandler } from "./extension-api.js";
import { cloneMap, registerUnique } from "./registry-utils.js";

/** @internal */
export interface BuiltWorkerProcessDefinition<TParams = unknown, TState = unknown> {
	/** @internal */
	startTurnId: TurnId | null;
	/** @internal */
	turns: ReadonlyMap<TurnId, WorkerTurnHandler<TParams, TState>>;
}

/** @internal */
export function createWorkerProcessBuilder<TParams = unknown, TState = unknown>(): WorkerProcessAPI<
	TParams,
	TState
> & {
	/** @internal */
	getDefinition(): BuiltWorkerProcessDefinition<TParams, TState>;
} {
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

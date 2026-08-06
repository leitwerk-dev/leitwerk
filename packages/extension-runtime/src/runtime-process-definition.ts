import type { TurnId } from "@leitwerk-dev/domain";
import {
	type BuiltWorkerProcessDefinition,
	createWorkerProcessBuilder,
	type ExtensionProcessDefinition,
	type ProcessPiConfig,
	type ProcessTurnBinding,
	type TurnDefinition,
} from "@leitwerk-dev/process-sdk";
import type { ExtensionCatalog } from "./extension-loader.js";

export interface RuntimeProcessDefinitionBuildOptions<TParams = unknown, TState = unknown> {
	params?: TParams;
	state?: TState;
}

/**
 * Resolved worker process definition with params and state ready for runtime.
 */
export interface ResolvedWorkerProcess<TParams = unknown, TState = unknown> {
	processId: string;
	startTurnId: TurnId;
	turns: ReadonlyMap<TurnId, ProcessTurnBinding<TurnDefinition<TParams, TState>>>;
	definition: BuiltWorkerProcessDefinition;
	repositoryCredentials?: ExtensionProcessDefinition<TParams, TState>["repositoryCredentials"];
	params: TParams;
	state: TState;
	piConfig?: ProcessPiConfig;
}

function hasOwnKey<T extends object>(value: T, key: PropertyKey): boolean {
	return Object.hasOwn(value, key);
}

function resolveParams<TParams, TState>(
	extensionProcess: ExtensionProcessDefinition<TParams, TState>,
	options?: RuntimeProcessDefinitionBuildOptions<TParams, TState>,
): TParams {
	if (options && hasOwnKey(options, "params")) {
		return options.params as TParams;
	}
	return extensionProcess.paramsCodec.parse(undefined);
}

function resolveState<TParams, TState>(
	extensionProcess: ExtensionProcessDefinition<TParams, TState>,
	params: TParams,
	options?: RuntimeProcessDefinitionBuildOptions<TParams, TState>,
): TState {
	if (options && hasOwnKey(options, "state")) {
		return options.state as TState;
	}
	return extensionProcess.initialState(params);
}

/**
 * Build a ResolvedWorkerProcess directly from an extension process definition.
 * Resolves params/state from options or codec defaults. Parses paramsJson/stateJson
 * when provided.
 */
export function buildWorkerRuntimeDefinition<TParams = unknown, TState = unknown>(
	extensionProcess: ExtensionProcessDefinition<TParams, TState>,
	options?: RuntimeProcessDefinitionBuildOptions<TParams, TState> & {
		paramsJson?: string | null;
		stateJson?: string | null;
	},
): ResolvedWorkerProcess<TParams, TState> | undefined {
	if (!extensionProcess.worker) {
		return undefined;
	}

	const proc = createWorkerProcessBuilder<TParams, TState>();
	extensionProcess.worker(proc);
	const built = proc.getDefinition();
	if (built.startTurnId === null) {
		return undefined;
	}
	if (built.startTurnId !== extensionProcess.entryTurnId) {
		throw new Error(
			`Worker process '${extensionProcess.id}' declares start turn '${built.startTurnId}' but the process entry turn is '${extensionProcess.entryTurnId}'`,
		);
	}

	let params: TParams;
	if (options?.paramsJson) {
		params = extensionProcess.paramsCodec.parse(JSON.parse(options.paramsJson));
	} else {
		params = resolveParams(extensionProcess, options);
	}

	let state: TState;
	if (options?.stateJson) {
		state = extensionProcess.stateCodec.parse(JSON.parse(options.stateJson));
	} else {
		state = resolveState(extensionProcess, params, options);
	}

	return {
		processId: extensionProcess.id,
		startTurnId: extensionProcess.entryTurnId,
		turns: extensionProcess.turns,
		definition: built as BuiltWorkerProcessDefinition,
		repositoryCredentials: extensionProcess.repositoryCredentials,
		params,
		state,
		piConfig: extensionProcess.piConfig,
	};
}

/**
 * Create a resolver that returns a ResolvedWorkerProcess from the catalog.
 */
export function createCatalogWorkerDefinitionResolver(
	catalog: Pick<ExtensionCatalog, "processes">,
): (
	processId: string,
	opts?: { paramsJson?: string | null; stateJson?: string | null },
) => ResolvedWorkerProcess | undefined {
	return (processId, opts) => {
		const extensionProcess = catalog.processes.get(processId);
		if (!extensionProcess) {
			return undefined;
		}
		return buildWorkerRuntimeDefinition(extensionProcess, opts);
	};
}

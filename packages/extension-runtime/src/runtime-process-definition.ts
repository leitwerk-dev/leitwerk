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
	runtime: { readonly developmentTools: boolean; readonly docker: boolean };
	params: TParams;
	state: TState;
	piConfig?: ProcessPiConfig;
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
	} else if (options && Object.hasOwn(options, "params")) {
		params = options.params as TParams;
	} else {
		params = extensionProcess.paramsCodec.parse(undefined);
	}

	let state: TState;
	if (options?.stateJson) {
		state = extensionProcess.stateCodec.parse(JSON.parse(options.stateJson));
	} else if (options && Object.hasOwn(options, "state")) {
		state = options.state as TState;
	} else {
		state = extensionProcess.initialState(params);
	}

	return {
		processId: extensionProcess.id,
		startTurnId: extensionProcess.entryTurnId,
		turns: extensionProcess.turns,
		definition: built as BuiltWorkerProcessDefinition,
		repositoryCredentials: extensionProcess.repositoryCredentials,
		runtime: {
			developmentTools: extensionProcess.runtime?.developmentTools === true,
			docker: extensionProcess.runtime?.docker === true,
		},
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

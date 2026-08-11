import type {
	ExtensionProcessDefinition,
	ProcessWatcherAPI,
	ProcessWatcherDefinition,
} from "./extension-api.js";
import { cloneMap, registerUnique } from "./registry-utils.js";

export interface BuiltProcessWatcherDefinition<TParams = unknown> {
	watchers: ReadonlyMap<string, ProcessWatcherDefinition<TParams, unknown, unknown>>;
}

function validateWatcherDefinition<TParams>(
	def: ProcessWatcherDefinition<TParams, unknown, unknown>,
): void {
	if (!def.id.trim()) {
		throw new Error("Process watcher id is required");
	}
	if (!def.label.trim()) {
		throw new Error(`Process watcher '${def.id}' must define a non-empty label`);
	}
	if (!def.description.trim()) {
		throw new Error(`Process watcher '${def.id}' must define a non-empty description`);
	}
	if (!def.source || def.source.id.trim() === "") {
		throw new Error(`Process watcher '${def.id}' must define a watcher source`);
	}
}

export function createProcessWatcherBuilder<TParams = unknown>(): ProcessWatcherAPI<TParams> & {
	getDefinition(): BuiltProcessWatcherDefinition<TParams>;
} {
	const watchers = new Map<string, ProcessWatcherDefinition<TParams, unknown, unknown>>();

	return {
		watcher<TEvent = unknown, TConfig = unknown>(
			def: ProcessWatcherDefinition<TParams, TEvent, TConfig>,
		) {
			registerUnique(
				watchers,
				def.id,
				def as unknown as ProcessWatcherDefinition<TParams, unknown, unknown>,
				{
					duplicateMessage: `Process watcher '${def.id}' is already registered`,
					validate: validateWatcherDefinition,
				},
			);
		},
		getDefinition() {
			return {
				watchers: cloneMap(watchers),
			};
		},
	};
}

export function buildProcessWatchers<TParams = unknown, TState = unknown>(
	process: ExtensionProcessDefinition<TParams, TState>,
): BuiltProcessWatcherDefinition<TParams> | undefined {
	if (!process.watchers) {
		return undefined;
	}
	const builder = createProcessWatcherBuilder<TParams>();
	process.watchers(builder);
	return builder.getDefinition();
}

import type { ProcessWatcherType } from "@leitwerk-dev/protocol";
import type {
	ExtensionProcessDefinition,
	ProcessWatcherAPI,
	ProcessWatcherDefinition,
} from "./extension-api.js";
import { cloneMap, registerUnique } from "./registry-utils.js";

export interface BuiltProcessWatcherDefinition<
	TParams = unknown,
	TType extends ProcessWatcherType = ProcessWatcherType,
> {
	watchers: ReadonlyMap<string, ProcessWatcherDefinition<TParams, unknown, TType>>;
}

function validateWatcherDefinition<TParams, TType extends ProcessWatcherType>(
	def: ProcessWatcherDefinition<TParams, unknown, TType>,
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
	if (
		def.type !== "jira" &&
		def.type !== "gitlab_mr" &&
		def.type !== "filesystem" &&
		def.type !== "forgejo_issue"
	) {
		throw new Error(`Process watcher '${def.id}' has unsupported type '${String(def.type)}'`);
	}
}

export function createProcessWatcherBuilder<
	TParams = unknown,
	TType extends ProcessWatcherType = ProcessWatcherType,
>(): ProcessWatcherAPI<TParams> & {
	getDefinition(): BuiltProcessWatcherDefinition<TParams, TType>;
} {
	const watchers = new Map<string, ProcessWatcherDefinition<TParams, unknown, TType>>();

	return {
		watcher<TEvent = unknown, TWatcherType extends ProcessWatcherType = ProcessWatcherType>(
			def: ProcessWatcherDefinition<TParams, TEvent, TWatcherType>,
		) {
			registerUnique(
				watchers,
				def.id,
				def as unknown as ProcessWatcherDefinition<TParams, unknown, TType>,
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

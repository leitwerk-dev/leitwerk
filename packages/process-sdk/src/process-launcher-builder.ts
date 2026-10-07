import type {
	ExtensionProcessDefinition,
	ProcessLauncherAPI,
	ProcessLauncherDefinition,
} from "./extension-api.js";
import { cloneMap, registerUnique } from "./registry-utils.js";

/** @public */
export interface BuiltProcessLauncherDefinition<TParams = unknown> {
	/** @public */
	launchers: ReadonlyMap<string, ProcessLauncherDefinition<TParams>>;
}

function validateLauncherDefinition<TParams>(def: ProcessLauncherDefinition<TParams>): void {
	if (!def.id.trim()) {
		throw new Error("Launcher id is required");
	}
	if (!def.label.trim()) {
		throw new Error(`Launcher '${def.id}' must define a non-empty label`);
	}
	if (!def.description.trim()) {
		throw new Error(`Launcher '${def.id}' must define a non-empty description`);
	}
	if (def.visibility !== "ui") {
		throw new Error(`Launcher '${def.id}' has unsupported visibility`);
	}
	if (!def.ui) {
		throw new Error(`UI launcher '${def.id}' must define a ui block`);
	}
}

/** @internal */
export function createProcessLauncherBuilder<TParams = unknown>(): ProcessLauncherAPI<TParams> & {
	/** @internal */
	getDefinition(): BuiltProcessLauncherDefinition<TParams>;
} {
	const launchers = new Map<string, ProcessLauncherDefinition<TParams>>();

	return {
		launcher(def: ProcessLauncherDefinition<TParams>) {
			registerUnique(launchers, def.id, def, {
				duplicateMessage: `Launcher '${def.id}' is already registered`,
				validate: validateLauncherDefinition,
			});
		},
		getDefinition() {
			return {
				launchers: cloneMap(launchers),
			};
		},
	};
}

/** @public */
export function buildProcessLaunchers<TParams = unknown, TState = unknown>(
	process: ExtensionProcessDefinition<TParams, TState>,
): BuiltProcessLauncherDefinition<TParams> | undefined {
	if (!process.launchers) {
		return undefined;
	}
	const builder = createProcessLauncherBuilder<TParams>();
	process.launchers(builder);
	return builder.getDefinition();
}

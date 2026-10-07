import type {
	ExtensionProcessDefinition,
	ProcessLeafOutcomeDefinition,
	UiProcessAPI,
} from "./extension-api.js";
import { validateProcessLeafOutcomeDefinition } from "./leaf-outcomes.js";

/** @internal */
export interface BuiltUiProcessDefinition<TParams = unknown, TState = unknown> {
	/** @internal */
	leafOutcome: ProcessLeafOutcomeDefinition<TParams, TState> | null;
}

/** @internal */
export function createUiProcessBuilder<TParams = unknown, TState = unknown>(): UiProcessAPI<
	TParams,
	TState
> & {
	/** @internal */
	getDefinition(): BuiltUiProcessDefinition<TParams, TState>;
} {
	let leafOutcome: ProcessLeafOutcomeDefinition<TParams, TState> | null = null;

	return {
		leafOutcome(def) {
			if (leafOutcome) {
				throw new Error("Leaf outcome is already registered");
			}
			const validationErrors = validateProcessLeafOutcomeDefinition(def);
			if (validationErrors.length > 0) {
				throw new Error(validationErrors.join("; "));
			}
			leafOutcome = def;
		},
		getDefinition() {
			return {
				leafOutcome,
			};
		},
	};
}

/** @internal */
export function buildUiProcessDefinition<TParams = unknown, TState = unknown>(
	process: ExtensionProcessDefinition<TParams, TState>,
): BuiltUiProcessDefinition<TParams, TState> | undefined {
	if (!process.ui) {
		return undefined;
	}
	const builder = createUiProcessBuilder<TParams, TState>();
	process.ui(builder);
	return builder.getDefinition();
}

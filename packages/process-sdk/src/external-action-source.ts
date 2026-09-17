import type { ExternalActionSource } from "./extension-api.js";

/** Define a resolver-based source with no provider input. */
export function defineExternalActionSource<TConfig>(
	metadata: Pick<ExternalActionSource, "kind" | "label" | "description" | "describeEvent">,
) {
	return function source<TParams, TState>(
		resolve: (ctx: { params: TParams; state: TState }) => TConfig,
	): ExternalActionSource<TParams, TState> {
		return { ...metadata, config: {}, inputMode: "none", resolve };
	};
}

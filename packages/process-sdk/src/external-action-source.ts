import type { ExternalActionSource } from "./extension-api.js";

/** Define a resolver-based source with no provider input. @public */
export function defineExternalActionSource<TConfig>(
	metadata: Pick<ExternalActionSource, "kind" | "label" | "description" | "describeEvent">,
) {
	return function source<TParams, TState>(
		resolve: (ctx: {
			/** @public */
			params: TParams;
			/** @public */
			state: TState;
		}) => TConfig,
	): ExternalActionSource<TParams, TState> {
		return { ...metadata, config: {}, inputMode: "none", resolve };
	};
}

import type { ExternalActionSource } from "@leitwerk-dev/process-sdk";
/** @internal */
export const WOODPECKER_PIPELINE_KIND = "@leitwerk-private/woodpecker.pipeline";
/** @internal */
export interface WoodpeckerPipelineSourceConfig {
	/** @internal */
	profile: string;
	/** @internal */
	owner: string;
	/** @internal */
	repo: string;
	/** @internal */
	branch: string;
	/** @internal */
	headSha: string;
	/** @internal */
	afterPipelineNumber?: number;
	/** @internal */
	disabled?: boolean;
	/** @internal */
	pollInterval?: string;
	/** @internal */
	statuses?: string[];
}
/** @internal */
export const woodpeckerExternal = {
	/** @internal */
	pipeline<TParams, TState>(
		resolve: (ctx: {
			/** @internal */
			params: TParams;
			/** @internal */
			state: TState;
		}) => WoodpeckerPipelineSourceConfig,
	): ExternalActionSource<TParams, TState> {
		return {
			kind: WOODPECKER_PIPELINE_KIND,
			label: "Woodpecker pipeline completion",
			description: "Fires when a pipeline matching the current source head completes",
			config: {},
			inputMode: "none",
			resolve,
		};
	},
};

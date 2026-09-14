import type { ExternalActionSource } from "@leitwerk-dev/process-sdk";
export const WOODPECKER_PIPELINE_KIND = "@leitwerk-private/woodpecker.pipeline";
export interface WoodpeckerPipelineSourceConfig {
	profile: string;
	owner: string;
	repo: string;
	branch: string;
	headSha: string;
	afterPipelineNumber?: number;
	disabled?: boolean;
	pollInterval?: string;
	statuses?: string[];
}
export const woodpeckerExternal = {
	pipeline<TParams, TState>(
		resolve: (ctx: { params: TParams; state: TState }) => WoodpeckerPipelineSourceConfig,
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

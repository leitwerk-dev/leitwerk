import { createCapabilityToken } from "@leitwerk-dev/process-sdk";
import type { WoodpeckerClient } from "./client.js";
/** Public contract shared by HTTP and local adapters. @public */
export type WoodpeckerClientLike = Pick<
	WoodpeckerClient,
	| "getPipeline"
	| "getStepLogs"
	| "listPipelines"
	| "lookupRepository"
	| "profile"
	| "restartPipeline"
>;

/** @public */
export interface WoodpeckerIntegration {
	/** @public */
	client(profile: string): WoodpeckerClientLike;
}
/** @internal */
export const woodpeckerIntegration = createCapabilityToken<WoodpeckerIntegration>(
	"@leitwerk-private/woodpecker.integration",
);

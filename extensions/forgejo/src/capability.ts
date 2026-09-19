import { createCapabilityToken } from "@leitwerk-dev/process-sdk";
import type { ForgejoClient } from "./client.js";

/** Public contract shared by HTTP and local adapters. */
/** @public */
export type ForgejoClientLike = Pick<ForgejoClient, keyof ForgejoClient>;

/** @public */
export interface ForgejoIntegration {
	/** @public */
	profiles(): readonly string[];
	/** @public */
	client(profile: string): ForgejoClientLike;
}

/** @internal */
export const forgejoIntegration = createCapabilityToken<ForgejoIntegration>(
	"@leitwerk-private/forgejo.integration",
);

import { createCapabilityToken } from "@leitwerk-dev/process-sdk";
import type { ForgejoClient } from "./client.js";

/** Public contract shared by HTTP and local adapters. */
export type ForgejoClientLike = Pick<ForgejoClient, keyof ForgejoClient>;

export interface ForgejoIntegration {
	profiles(): readonly string[];
	client(profile: string): ForgejoClientLike;
}

export const forgejoIntegration = createCapabilityToken<ForgejoIntegration>(
	"@leitwerk-private/forgejo.integration",
);

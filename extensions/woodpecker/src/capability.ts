import { createCapabilityToken } from "@leitwerk-dev/process-sdk";
import type { WoodpeckerClient } from "./client.js";
/** Public contract shared by HTTP and local adapters. */
export type WoodpeckerClientLike = Pick<WoodpeckerClient, keyof WoodpeckerClient>;

export interface WoodpeckerIntegration {
	client(profile: string): WoodpeckerClientLike;
}
export const woodpeckerIntegration = createCapabilityToken<WoodpeckerIntegration>(
	"@leitwerk-private/woodpecker.integration",
);

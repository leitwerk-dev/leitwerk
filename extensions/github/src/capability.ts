import { createCapabilityToken } from "@leitwerk-dev/process-sdk";
import type { GitHubClient } from "./client.js";

/** Public contract shared by HTTP and local adapters. @public */
export type GitHubClientLike = Pick<GitHubClient, keyof GitHubClient>;

/** @public */
export interface GitHubIntegration {
	/** @public */
	profiles?(): readonly string[];
	/** @public */
	client(profile: string): GitHubClientLike;
}

/** @public */
export const githubIntegration = createCapabilityToken<GitHubIntegration>(
	"@leitwerk-private/github.integration",
);

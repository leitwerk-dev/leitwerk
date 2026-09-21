import { createCapabilityToken } from "@leitwerk-dev/process-sdk";
import type { GitHubClient } from "./client.js";

/** Public contract shared by HTTP and local adapters. */
export type GitHubClientLike = Pick<GitHubClient, keyof GitHubClient>;

export interface GitHubIntegration {
	profiles?(): readonly string[];
	client(profile: string): GitHubClientLike;
}

export const githubIntegration = createCapabilityToken<GitHubIntegration>(
	"@leitwerk-private/github.integration",
);

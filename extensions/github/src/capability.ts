import { createCapabilityToken } from "@leitwerk-dev/process-sdk";
import type { GitHubClient } from "./client.js";

/** Public contract shared by HTTP and local adapters. @public */
export type GitHubClientLike = Pick<
	GitHubClient,
	| "addFeedbackReaction"
	| "addIssueComment"
	| "authorizedTrigger"
	| "createLabel"
	| "createPullRequest"
	| "downloadReleaseAsset"
	| "getCheckSummary"
	| "getCommit"
	| "getIssue"
	| "getPullRequest"
	| "isAncestor"
	| "isOrganizationMember"
	| "listActionablePullRequestFeedback"
	| "listFeedbackReactions"
	| "listFeedbackReplies"
	| "listIssueComments"
	| "listIssueEvents"
	| "listLabels"
	| "listOpenIssues"
	| "listPullRequestFeedback"
	| "listPullRequests"
	| "listReleases"
	| "listRepositories"
	| "profile"
	| "replyFeedback"
	| "resolveGitIdentity"
	| "updateIssue"
	| "updatePullRequest"
>;

/** @public */
export interface GitHubIntegration {
	/** @public */
	client(profile: string): GitHubClientLike;
}

/** @public */
export const githubIntegration = createCapabilityToken<GitHubIntegration>(
	"@leitwerk-private/github.integration",
);

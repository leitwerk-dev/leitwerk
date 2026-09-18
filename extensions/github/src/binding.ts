import { resolveRepositoryProjectBinding } from "@leitwerk-dev/process-sdk";

export type { RepositoryProjectBinding as GitHubProjectBinding } from "@leitwerk-dev/process-sdk";
/** @public */
export const resolveGitHubProjectBinding = (
	ctx: Parameters<typeof resolveRepositoryProjectBinding>[0],
) => resolveRepositoryProjectBinding(ctx, "github");

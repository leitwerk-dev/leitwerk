import { resolveRepositoryProjectBinding } from "@leitwerk-dev/process-sdk";

export type { RepositoryProjectBinding as ForgejoProjectBinding } from "@leitwerk-dev/process-sdk";
/** @internal */
export const resolveForgejoProjectBinding = (
	ctx: Parameters<typeof resolveRepositoryProjectBinding>[0],
) => resolveRepositoryProjectBinding(ctx, "forgejo");

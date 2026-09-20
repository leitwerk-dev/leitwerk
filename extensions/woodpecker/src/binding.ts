import { resolveRepositoryProjectBinding } from "@leitwerk-dev/process-sdk";

/** @internal */
export const resolveWoodpeckerProjectBinding = (
	ctx: Parameters<typeof resolveRepositoryProjectBinding>[0],
) => resolveRepositoryProjectBinding(ctx, "woodpecker", "forgejo");

import { resolveRepositoryProjectBinding } from "@leitwerk-dev/process-sdk";

export type { RepositoryProjectBinding as WoodpeckerProjectBinding } from "@leitwerk-dev/process-sdk";
export const resolveWoodpeckerProjectBinding = (
	ctx: Parameters<typeof resolveRepositoryProjectBinding>[0],
) => resolveRepositoryProjectBinding(ctx, "woodpecker", "forgejo");

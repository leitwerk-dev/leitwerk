import type { IntegrationToolExecutionContext } from "@leitwerk-dev/process-sdk";

/** Non-secret binding written by the server's process launch composition. */
export interface ForgejoProjectBinding {
	owner: string;
	repo: string;
	profile: string;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid forgejo project binding");
	return value as Record<string, unknown>;
}
function text(value: unknown, key: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`forgejo binding ${key} must be a non-empty string`);
	return value.trim();
}
/** Resolve only the project already authorized by the server tool registry. */
export function resolveForgejoProjectBinding(
	ctx: Pick<IntegrationToolExecutionContext, "project" | "process">,
): ForgejoProjectBinding {
	if (!ctx.project || ctx.project.instanceId !== ctx.process.id)
		throw new Error("An authorized process project is required");
	const metadata = object(ctx.project.metadata ?? {});
	const binding = object(metadata.forgejo);
	const profile =
		binding.profile === undefined
			? object(JSON.parse(ctx.process.paramsJson ?? "{}")).forgejoProfile
			: binding.profile;
	return {
		owner: text(binding.owner, "owner"),
		repo: text(binding.repo, "repo"),
		profile: text(profile, "profile"),
	};
}

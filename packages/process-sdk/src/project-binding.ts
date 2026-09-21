import type { IntegrationToolExecutionContext } from "./extension-api.js";
import { objectArg } from "./tool-arguments.js";

/** @public */
export interface RepositoryProjectBinding {
	/** @public */
	owner: string;
	/** @public */
	repo: string;
	/** @public */
	profile: string;
}

/** Validate an authorized project's binding, retaining extension-selected legacy metadata. @public */
export function resolveRepositoryProjectBinding(
	ctx: Pick<IntegrationToolExecutionContext, "project" | "process">,
	provider: string,
	legacyMetadataKey?: string,
): RepositoryProjectBinding {
	const object = (value: unknown) => objectArg(value, `Invalid ${provider} project binding`);
	function text(value: unknown, key: string): string {
		if (typeof value !== "string" || !value.trim())
			throw new Error(`${provider} binding ${key} must be a non-empty string`);
		return value.trim();
	}
	if (!ctx.project || ctx.project.instanceId !== ctx.process.id)
		throw new Error("An authorized process project is required");
	const metadata = object(ctx.project.metadata ?? {});
	const useLegacy = legacyMetadataKey !== undefined && metadata[provider] === undefined;
	const binding = object(metadata[useLegacy ? legacyMetadataKey : provider]);
	const profile =
		useLegacy || (legacyMetadataKey === undefined && binding.profile === undefined)
			? object(JSON.parse(ctx.process.paramsJson ?? "{}"))[`${provider}Profile`]
			: binding.profile;
	return {
		owner: text(binding.owner, "owner"),
		repo: text(binding.repo, "repo"),
		profile: text(profile, "profile"),
	};
}

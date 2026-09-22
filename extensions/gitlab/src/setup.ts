import { coreHostCapabilities, type ServerExtensionAPI } from "@leitwerk-dev/process-sdk";
import { type GitLabIntegration, gitlabIntegration } from "./capability.js";
import { registerGitLabDeliveryTools } from "./delivery-tools.js";
import { createGitLabProvider } from "./external.js";
import { registerGitLabTools } from "./tools.js";

/** Register shared tools and polling with an explicit integration. @public */
export function setupGitLabIntegration(
	api: ServerExtensionAPI,
	integration: GitLabIntegration,
	options: {
		/** @public */
		now?: () => number;
	} = {},
) {
	api.provide(gitlabIntegration, integration);
	const deps = api.get(coreHostCapabilities.serverSetup);
	if (!deps || Array.isArray(deps)) return;
	registerGitLabTools(api, integration);
	registerGitLabDeliveryTools(api, integration, deps.projects);
	return createGitLabProvider(deps, integration, options);
}

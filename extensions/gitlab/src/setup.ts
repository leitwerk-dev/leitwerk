import {
	coreHostCapabilities,
	type ServerExtensionAPI,
	type TicketCreationConfig,
} from "@leitwerk-dev/process-sdk";
import { type GitLabIntegration, gitlabIntegration } from "./capability.js";
import { registerGitLabDeliveryTools } from "./delivery-tools.js";
import { createGitLabProvider } from "./external.js";
import { registerGitLabTicketCreation } from "./ticket-creation.js";
import { registerGitLabTools } from "./tools.js";

/** Register shared tools and polling with an explicit integration. @public */
export function setupGitLabIntegration(
	api: ServerExtensionAPI,
	integration: GitLabIntegration,
	options: {
		/** @public */
		now?: () => number;
		/** @internal */
		ticketCreation?: TicketCreationConfig;
	} = {},
) {
	api.provide(gitlabIntegration, integration);
	const deps = api.get(coreHostCapabilities.serverSetup);
	if (!deps || Array.isArray(deps)) return;
	registerGitLabTools(api, integration);
	registerGitLabTicketCreation(
		api,
		integration,
		options.ticketCreation ?? { enabled: false, defaultLabels: [] },
	);
	registerGitLabDeliveryTools(api, integration, deps.projects);
	return createGitLabProvider(deps, integration, options);
}

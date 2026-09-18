import {
	coreHostCapabilities,
	type LeitwerkExtensionModule,
	type ServerExtensionAPI,
} from "@leitwerk-dev/process-sdk";
import { type GitLabIntegration, gitlabIntegration } from "./capability.js";
import { GitLabClient, parseGitLabProfiles } from "./client.js";
import { createGitLabProvider } from "./external.js";
import { registerGitLabTools } from "./tools.js";
/** @internal */
export const manifest = {
	/** @internal */
	id: "gitlab",
	/** @internal */
	version: "0.1.9",
} as const;
/** @public */
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
	return createGitLabProvider(deps, integration, options);
}
/** @public */
const extension: LeitwerkExtensionModule = {
	manifest,
	setupServer(api, config) {
		const profiles = parseGitLabProfiles(config);
		const clients = new Map([...profiles].map(([id, profile]) => [id, new GitLabClient(profile)]));
		setupGitLabIntegration(api, {
			profiles: () => [...profiles.keys()],
			client: (profile) => {
				const client = clients.get(profile);
				if (!client) throw new Error(`Unknown GitLab profile '${profile}'`);
				return client;
			},
		});
		const deps = api.get(coreHostCapabilities.serverSetup);
		if (!deps || Array.isArray(deps)) return;
		deps.repositoryCredentials.register({
			kind: "git_https",
			resolve(ref) {
				const profile = ref.startsWith("gitlab:") ? profiles.get(ref.slice(7)) : undefined;
				return profile
					? { origin: profile.baseUrl, username: "oauth2", password: profile.token }
					: null;
			},
		});
	},
};
export default extension;
export * from "./capability.js";
export * from "./client.js";
export * from "./external.js";
export * from "./selection.js";
export * from "./tools.js";

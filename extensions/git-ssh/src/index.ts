import {
	coreHostCapabilities,
	createCapabilityToken,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import { parseProfiles, preflightGitSshAccess } from "./git-ssh-internal.js";

/** @internal */
const manifest = {
	/** @internal */
	id: "git-ssh",
	/** @internal */
	version: "0.1.0",
} as const;

/** @public */
interface GitSshAuthorizationPreflightInput {
	/** @public */
	credentialRef: string;
	/** @public */
	repoLocator: string;
	/** @public */
	baseBranch: string;
	/** @public */
	requireWrite: boolean;
}

/** @public */
type GitSshAuthorizationPreflightResult =
	| {
			/** @public */
			ok: true;
	  }
	| {
			/** @public */
			ok: false;
			/** @public */
			access: "read" | "write";
			/** @public */
			detail: string;
	  };

/** @public */
export interface GitSshIntegration {
	/** @public */
	profiles(): readonly string[];
	/** @public */
	preflight(input: GitSshAuthorizationPreflightInput): Promise<GitSshAuthorizationPreflightResult>;
}

/** @public */
export const gitSshIntegration = createCapabilityToken<GitSshIntegration>(
	"@leitwerk-dev/git-ssh.integration",
);

/** @public */
const extension: LeitwerkExtensionModule = {
	manifest,
	setupServer(api, config) {
		const deps = api.get(coreHostCapabilities.serverSetup);
		if (!deps || Array.isArray(deps)) return;
		const profiles = parseProfiles(config);
		deps.repositoryCredentials.register({
			kind: "git_ssh",
			resolve: (ref) => profiles.get(ref) ?? null,
		});
		api.provide(gitSshIntegration, {
			profiles: () => [...profiles.keys()].sort(),
			async preflight(input) {
				const material = profiles.get(input.credentialRef);
				if (!material) {
					return {
						ok: false,
						access: "read",
						detail: `Unknown git_ssh credential '${input.credentialRef}'`,
					};
				}
				return preflightGitSshAccess(input, material);
			},
		});
	},
};

export default extension;

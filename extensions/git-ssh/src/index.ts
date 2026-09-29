import {
	coreHostCapabilities,
	createCapabilityToken,
	type LaunchPreparationCheck,
	type LeitwerkExtensionModule,
	SafeLaunchPreparationError,
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

/** Shared repository launch check; integration lookup stays lazy across reconfiguration. @internal */
export function createGitSshPreparationCheck<
	P extends {
		/** @internal */
		sshCredentialRef: string;
		/** @internal */
		repoLocator: string;
		/** @internal */
		baseBranch: string;
		/** @internal */
		owner: string;
		/** @internal */
		repo: string;
	},
>(
	access: "read" | "write",
	params: P,
	integration: () => GitSshIntegration,
): LaunchPreparationCheck<P> {
	return {
		id: `ssh_${access}`,
		label: `Verify SSH ${access} access`,
		async run({ signal, logger }) {
			signal.throwIfAborted();
			const result = await integration().preflight({
				credentialRef: params.sshCredentialRef,
				repoLocator: params.repoLocator,
				baseBranch: params.baseBranch,
				requireWrite: access === "write",
			});
			signal.throwIfAborted();
			if (!result.ok) {
				logger.warn(`Git SSH ${result.access} preflight failed: ${result.detail}`);
				throw new SafeLaunchPreparationError(
					`SSH ${result.access} access failed: ${result.detail}`,
					`Authorize Git SSH profile '${params.sshCredentialRef}' for '${params.owner}/${params.repo}' with read/write access, then try again.`,
				);
			}
		},
	};
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

import {
	createRepositoryChangeParamsCodec,
	normalizeRepositoryIssueChangeParams,
	type RepositoryChangeLaunchParams,
	type RepositoryIssueOriginParams,
	type RepositoryUiOriginParams,
} from "@leitwerk-dev/coding/repository-change-launch";

/** @public */
interface ForgejoRepoChangeCommonParams {
	/** @internal */
	forgejoProfile: string;
	/** @internal */
	woodpeckerProfile: string;
	/** @internal */
	sshCredentialRef: string;
	/** @internal */
	owner: string;
	/** @internal */
	repo: string;
}

/** @public */
export interface ForgejoIssueOriginParams extends RepositoryIssueOriginParams {}

/** @public */
export interface ForgejoUiOriginParams extends RepositoryUiOriginParams {}

/** @public */
export type ForgejoRepoChangeParams = RepositoryChangeLaunchParams<
	ForgejoRepoChangeCommonParams & (ForgejoIssueOriginParams | ForgejoUiOriginParams)
>;

/** @internal */
export function isIssueOrigin(
	params: ForgejoRepoChangeParams,
): params is ForgejoRepoChangeParams & ForgejoIssueOriginParams {
	return params.origin === "issue";
}

/** @internal */
export const forgejoRepoChangeParamsCodec =
	createRepositoryChangeParamsCodec<ForgejoRepoChangeParams>({
		normalize(value) {
			return normalizeRepositoryIssueChangeParams(value, "Forgejo Repo Change", [
				"forgejoProfile",
				"woodpeckerProfile",
				"sshCredentialRef",
				"owner",
				"repo",
			]);
		},
	});

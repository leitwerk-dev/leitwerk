import {
	createRepositoryChangeParamsCodec,
	normalizeRepositoryIssueChangeParams,
	type RepositoryChangeLaunchParams,
	type RepositoryIssueOriginParams,
	type RepositoryUiOriginParams,
} from "@leitwerk-dev/coding/repository-change-launch";

/** @public */
interface GitHubRepoChangeCommonParams {
	/** @public */
	githubProfile: string;
	/** @public */
	sshCredentialRef: string;
	/** @public */
	owner: string;
	/** @public */
	repo: string;
}

/** @public */
export interface GitHubIssueOriginParams extends RepositoryIssueOriginParams {}

/** @public */
export interface GitHubUiOriginParams extends RepositoryUiOriginParams {}

/** @public */
export type GitHubRepoChangeParams = RepositoryChangeLaunchParams<
	GitHubRepoChangeCommonParams & (GitHubIssueOriginParams | GitHubUiOriginParams)
>;

/** @public */
export function isIssueOrigin(
	params: GitHubRepoChangeParams,
): params is GitHubRepoChangeParams & GitHubIssueOriginParams {
	return params.origin === "issue";
}

/** @public */
export const githubRepoChangeParamsCodec =
	createRepositoryChangeParamsCodec<GitHubRepoChangeParams>({
		normalize(value) {
			return normalizeRepositoryIssueChangeParams(value, "GitHub Repo Change", [
				"githubProfile",
				"sshCredentialRef",
				"owner",
				"repo",
			]);
		},
	});

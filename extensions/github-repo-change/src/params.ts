import {
	createRepositoryChangeParamsCodec,
	normalizeRepositoryChangeParamsInput,
	normalizeRepositoryIssueOrigin,
	type RepositoryChangeLaunchParams,
	type RepositoryIssueOriginParams,
	type RepositoryUiOriginParams,
	repositoryChangeParamsRecord,
} from "@leitwerk-dev/coding/repository-change-launch";
import { trimString } from "@leitwerk-dev/domain";

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
			const shared = normalizeRepositoryChangeParamsInput(value, "GitHub Repo Change");
			const record = repositoryChangeParamsRecord(value, "GitHub Repo Change");
			const text = (name: string) => {
				const value = trimString(record[name]);
				if (!value) throw new Error(`GitHub Repo Change requires ${name}`);
				return value;
			};

			const common = {
				...shared,
				githubProfile: text("githubProfile"),
				sshCredentialRef: text("sshCredentialRef"),
				owner: text("owner"),
				repo: text("repo"),
			};
			return { ...common, ...normalizeRepositoryIssueOrigin(record, "GitHub Repo Change", text) };
		},
	});

import {
	createRepositoryChangeParamsCodec,
	normalizeRepositoryChangeParamsInput,
	type RepositoryChangeLaunchParams,
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
export interface GitHubIssueOriginParams {
	/** @public */
	origin: "issue";
	/** @public */
	issueNumber: number;
	/** @public */
	issueUrl: string;
	/** @public */
	triggerLabel: string;
	/** @public */
	doneLabel: string;
}

/** @public */
export interface GitHubUiOriginParams {
	/** @public */
	origin: "ui";
	/** @public */
	issueNumber: null;
	/** @public */
	issueUrl: null;
	/** @public */
	triggerLabel: null;
	/** @public */
	doneLabel: null;
}

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
			const origin = trimString(record.origin);
			if (origin === "ui") {
				return {
					...common,
					origin: "ui" as const,
					issueNumber: null,
					issueUrl: null,
					triggerLabel: null,
					doneLabel: null,
				};
			}
			if (origin && origin !== "issue") {
				throw new Error("GitHub Repo Change requires a valid origin");
			}

			if (
				typeof record.issueNumber !== "number" ||
				!Number.isInteger(record.issueNumber) ||
				record.issueNumber <= 0
			)
				throw new Error("GitHub Repo Change requires issueNumber");
			return {
				...common,
				origin: "issue" as const,
				issueNumber: record.issueNumber,
				issueUrl: text("issueUrl"),
				triggerLabel: text("triggerLabel"),
				doneLabel: text("doneLabel"),
			};
		},
	});

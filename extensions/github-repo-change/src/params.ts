import {
	createRepositoryChangeParamsCodec,
	normalizeRepositoryChangeParamsInput,
	type RepositoryChangeLaunchParams,
	repositoryChangeParamsRecord,
} from "@leitwerk-dev/coding/repository-change-launch";
import { trimString } from "@leitwerk-dev/domain";

interface GitHubRepoChangeCommonParams {
	githubProfile: string;
	sshCredentialRef: string;
	owner: string;
	repo: string;
}

export interface GitHubIssueOriginParams {
	origin: "issue";
	issueNumber: number;
	issueUrl: string;
	triggerLabel: string;
	doneLabel: string;
}

export interface GitHubUiOriginParams {
	origin: "ui";
	issueNumber: null;
	issueUrl: null;
	triggerLabel: null;
	doneLabel: null;
}

export type GitHubRepoChangeParams = RepositoryChangeLaunchParams<
	GitHubRepoChangeCommonParams & (GitHubIssueOriginParams | GitHubUiOriginParams)
>;

export function isIssueOrigin(
	params: GitHubRepoChangeParams,
): params is GitHubRepoChangeParams & GitHubIssueOriginParams {
	return params.origin === "issue";
}

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

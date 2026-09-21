import {
	createRepositoryChangeParamsCodec,
	normalizeRepositoryChangeParamsInput,
	type RepositoryChangeLaunchParams,
	repositoryChangeParamsRecord,
} from "@leitwerk-dev/coding/repository-change-launch";
import { trimString } from "@leitwerk-dev/domain";
export type GitLabRepoChangeParams = RepositoryChangeLaunchParams<
	{
		gitlabProfile: string;
		gitlabOrigin: string;
		projectId: number;
		owner: string;
		repo: string;
	} & (
		| { origin: "ui"; issueNumber: null; issueUrl: null; triggerLabel: null; doneLabel: null }
		| {
				origin: "issue";
				issueNumber: number;
				issueUrl: string;
				triggerLabel: string;
				doneLabel: string;
		  }
	)
>;
export const gitlabRepoChangeParamsCodec =
	createRepositoryChangeParamsCodec<GitLabRepoChangeParams>({
		normalize(value) {
			const r = repositoryChangeParamsRecord(value, "GitLab Repo Change");
			const text = (key: string) => {
				const v = trimString(r[key]);
				if (!v) throw new Error(`GitLab Repo Change requires ${key}`);
				return v;
			};
			if (typeof r.projectId !== "number" || !Number.isSafeInteger(r.projectId) || r.projectId <= 0)
				throw new Error("GitLab Repo Change requires projectId");
			const common = {
				...normalizeRepositoryChangeParamsInput(value, "GitLab Repo Change"),
				gitlabProfile: text("gitlabProfile"),
				gitlabOrigin: text("gitlabOrigin"),
				projectId: r.projectId,
				owner: text("owner"),
				repo: text("repo"),
			};
			if (r.origin === "ui")
				return {
					...common,
					origin: "ui",
					issueNumber: null,
					issueUrl: null,
					triggerLabel: null,
					doneLabel: null,
				};
			if (
				r.origin !== "issue" ||
				typeof r.issueNumber !== "number" ||
				!Number.isSafeInteger(r.issueNumber) ||
				r.issueNumber <= 0
			)
				throw new Error("GitLab Repo Change requires a valid origin and issueNumber");
			return {
				...common,
				origin: "issue",
				issueNumber: r.issueNumber,
				issueUrl: text("issueUrl"),
				triggerLabel: text("triggerLabel"),
				doneLabel: text("doneLabel"),
			};
		},
	});

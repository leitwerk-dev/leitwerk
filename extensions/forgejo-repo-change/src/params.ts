import {
	createRepositoryChangeParamsCodec,
	normalizeRepositoryChangeParamsInput,
	type RepositoryChangeLaunchParams,
	repositoryChangeParamsRecord,
} from "@leitwerk-dev/coding/repository-change-launch";
import { trimString } from "@leitwerk-dev/domain";

interface ForgejoRepoChangeCommonParams {
	forgejoProfile: string;
	woodpeckerProfile: string;
	sshCredentialRef: string;
	owner: string;
	repo: string;
}

export interface ForgejoIssueOriginParams {
	origin: "issue";
	issueNumber: number;
	issueUrl: string;
	triggerLabel: string;
	doneLabel: string;
}

export interface ForgejoUiOriginParams {
	origin: "ui";
	issueNumber: null;
	issueUrl: null;
	triggerLabel: null;
	doneLabel: null;
}

export type ForgejoRepoChangeParams = RepositoryChangeLaunchParams<
	ForgejoRepoChangeCommonParams & (ForgejoIssueOriginParams | ForgejoUiOriginParams)
>;

export function isIssueOrigin(
	params: ForgejoRepoChangeParams,
): params is ForgejoRepoChangeParams & ForgejoIssueOriginParams {
	return params.origin === "issue";
}

export const forgejoRepoChangeParamsCodec =
	createRepositoryChangeParamsCodec<ForgejoRepoChangeParams>({
		normalize(value) {
			const shared = normalizeRepositoryChangeParamsInput(value, "Forgejo Repo Change");
			const record = repositoryChangeParamsRecord(value, "Forgejo Repo Change");
			const text = (name: string) => {
				const value = trimString(record[name]);
				if (!value) throw new Error(`Forgejo Repo Change requires ${name}`);
				return value;
			};

			const common = {
				...shared,
				forgejoProfile: text("forgejoProfile"),
				woodpeckerProfile: text("woodpeckerProfile"),
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
				throw new Error("Forgejo Repo Change requires a valid origin");
			}

			if (
				typeof record.issueNumber !== "number" ||
				!Number.isInteger(record.issueNumber) ||
				record.issueNumber <= 0
			)
				throw new Error("Forgejo Repo Change requires issueNumber");
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

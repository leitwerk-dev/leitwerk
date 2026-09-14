import {
	createRepositoryChangeParamsCodec,
	normalizeRepositoryChangeParamsInput,
	type RepositoryChangeLaunchParams,
	repositoryChangeParamsRecord,
} from "@leitwerk-dev/coding/repository-change-launch";

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
		displayName: "Forgejo Repo Change",
		normalize(value) {
			const shared = normalizeRepositoryChangeParamsInput(value, "Forgejo Repo Change");
			const record = repositoryChangeParamsRecord(value, "Forgejo Repo Change");
			const text = (name: string) =>
				typeof record[name] === "string" ? (record[name] as string).trim() : "";
			for (const name of [
				"forgejoProfile",
				"woodpeckerProfile",
				"sshCredentialRef",
				"owner",
				"repo",
			])
				if (!text(name)) throw new Error(`Forgejo Repo Change requires ${name}`);

			const common = {
				...shared,
				forgejoProfile: text("forgejoProfile"),
				woodpeckerProfile: text("woodpeckerProfile"),
				sshCredentialRef: text("sshCredentialRef"),
				owner: text("owner"),
				repo: text("repo"),
			};
			const origin = text("origin");
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
			for (const name of ["issueUrl", "triggerLabel", "doneLabel"])
				if (!text(name)) throw new Error(`Forgejo Repo Change requires ${name}`);
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

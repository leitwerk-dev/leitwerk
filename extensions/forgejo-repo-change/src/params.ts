import {
	createRepositoryChangeParamsCodec,
	normalizeRepositoryChangeParamsInput,
	type RepositoryChangeLaunchParams,
	repositoryChangeParamsRecord,
} from "@leitwerk-dev/coding/repository-change-launch";
import { trimString } from "@leitwerk-dev/domain";

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
export interface ForgejoIssueOriginParams {
	/** @internal */
	origin: "issue";
	/** @internal */
	issueNumber: number;
	/** @internal */
	issueUrl: string;
	/** @internal */
	triggerLabel: string;
	/** @internal */
	doneLabel: string;
}

/** @public */
export interface ForgejoUiOriginParams {
	/** @internal */
	origin: "ui";
	/** @internal */
	issueNumber: null;
	/** @internal */
	issueUrl: null;
	/** @internal */
	triggerLabel: null;
	/** @internal */
	doneLabel: null;
}

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
		displayName: "Forgejo Repo Change",
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

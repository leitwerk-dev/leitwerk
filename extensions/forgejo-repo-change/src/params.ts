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
			return { ...common, ...normalizeRepositoryIssueOrigin(record, "Forgejo Repo Change", text) };
		},
	});

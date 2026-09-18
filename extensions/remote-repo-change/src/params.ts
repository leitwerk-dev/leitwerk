import {
	createRepositoryChangeParamsCodec,
	type NormalizedRepositoryChangeParamsInput,
	normalizeRepositoryChangeParamsInput,
	type RepositoryChangeLaunchKind,
	type RepositoryChangeLaunchParams,
	repositoryChangeParamsRecord,
} from "@leitwerk-dev/coding/repository-change-launch";
import { trimString } from "@leitwerk-dev/domain";

/** @internal */
export type RemoteRepoChangeLaunchKind = RepositoryChangeLaunchKind;
/** @internal */
export type RemoteRepoChangeParams = RepositoryChangeLaunchParams<{
	/** @internal */
	sshCredentialRef: string;
}>;
export type NormalizedRemoteRepoChangeParamsInput = NormalizedRepositoryChangeParamsInput & {
	sshCredentialRef: string;
};

export function normalizeRemoteRepoChangeParamsInput(
	value: unknown,
): NormalizedRemoteRepoChangeParamsInput {
	const normalized = normalizeRepositoryChangeParamsInput(value, "Remote Repo Change");
	const record = repositoryChangeParamsRecord(value, "Remote Repo Change");
	return { ...normalized, sshCredentialRef: trimString(record.sshCredentialRef) };
}

/** @internal */
export const remoteRepoChangeParamsCodec =
	createRepositoryChangeParamsCodec<RemoteRepoChangeParams>({
		displayName: "Remote Repo Change",
		normalize: normalizeRemoteRepoChangeParamsInput,
	});

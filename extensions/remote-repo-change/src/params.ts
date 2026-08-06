import {
	createRepositoryChangeParamsCodec,
	type NormalizedRepositoryChangeParamsInput,
	normalizeRepositoryChangeParamsInput,
	type RepositoryChangeLaunchKind,
	type RepositoryChangeLaunchParams,
	repositoryChangeParamsRecord,
} from "@leitwerk-dev/coding/repository-change-launch";
import { trimString } from "@leitwerk-dev/domain";

export type RemoteRepoChangeLaunchKind = RepositoryChangeLaunchKind;
export type RemoteRepoChangeParams = RepositoryChangeLaunchParams<{ sshCredentialRef: string }>;
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

export const remoteRepoChangeParamsCodec =
	createRepositoryChangeParamsCodec<RemoteRepoChangeParams>({
		displayName: "Remote Repo Change",
		normalize: normalizeRemoteRepoChangeParamsInput,
	});

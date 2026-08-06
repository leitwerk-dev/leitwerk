import {
	createRepositoryChangeParamsCodec,
	type NormalizedRepositoryChangeParamsInput,
	normalizeRepositoryChangeParamsInput,
	type RepositoryChangeLaunchKind,
	type RepositoryChangeLaunchParams,
} from "@leitwerk-dev/coding/repository-change-launch";

export type LocalRepoChangeLaunchKind = RepositoryChangeLaunchKind;
export type LocalRepoChangeParams = RepositoryChangeLaunchParams;
export type NormalizedLocalRepoChangeParamsInput = NormalizedRepositoryChangeParamsInput;

export function normalizeLocalRepoChangeParamsInput(
	value: unknown,
): NormalizedLocalRepoChangeParamsInput {
	return normalizeRepositoryChangeParamsInput(value, "Local Repo Change");
}

export const localRepoChangeParamsCodec = createRepositoryChangeParamsCodec<LocalRepoChangeParams>({
	displayName: "Local Repo Change",
	normalize: normalizeLocalRepoChangeParamsInput,
});

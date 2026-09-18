import {
	createRepositoryChangeParamsCodec,
	type NormalizedRepositoryChangeParamsInput,
	normalizeRepositoryChangeParamsInput,
	type RepositoryChangeLaunchKind,
	type RepositoryChangeLaunchParams,
} from "@leitwerk-dev/coding/repository-change-launch";

/** @internal */
export type LocalRepoChangeLaunchKind = RepositoryChangeLaunchKind;
/** @internal */
export type LocalRepoChangeParams = RepositoryChangeLaunchParams;
export type NormalizedLocalRepoChangeParamsInput = NormalizedRepositoryChangeParamsInput;

export function normalizeLocalRepoChangeParamsInput(
	value: unknown,
): NormalizedLocalRepoChangeParamsInput {
	return normalizeRepositoryChangeParamsInput(value, "Local Repo Change");
}

/** @internal */
export const localRepoChangeParamsCodec = createRepositoryChangeParamsCodec<LocalRepoChangeParams>({
	displayName: "Local Repo Change",
	normalize: normalizeLocalRepoChangeParamsInput,
});

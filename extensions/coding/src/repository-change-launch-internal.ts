import { parseRepoLocator, trimString } from "@leitwerk-dev/domain";
import type { Codec } from "@leitwerk-dev/process-sdk";

/** @public */
export interface RepositoryChangeParamsBase {
	/** @public */
	repoLocator: string;
	/** @public */
	baseBranch: string;
	/** @public */
	workBranch: string;
	/** @public */
	prompt: string;
}

/** @public */
export type RepositoryChangeLaunchParams<TExtra extends object = Record<never, never>> = TExtra &
	RepositoryChangeParamsBase;

/** @public */
export interface NormalizedRepositoryChangeParamsInput {
	/** @internal */
	repoLocator: string;
	/** @internal */
	baseBranch: string;
	/** @internal */
	workBranch: string;
	/** @internal */
	prompt: string;
}

/** @public */
export function repositoryChangeParamsRecord(
	value: unknown,
	displayName: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${displayName} params must be an object`);
	}
	return value as Record<string, unknown>;
}

/** @public */
export function normalizeRepositoryChangeParamsInput(
	value: unknown,
	displayName: string,
): NormalizedRepositoryChangeParamsInput {
	const record = repositoryChangeParamsRecord(value, displayName);
	const rawRepoLocator = trimString(record.repoLocator);
	return {
		repoLocator: parseRepoLocator(rawRepoLocator)?.value ?? rawRepoLocator,
		baseBranch: trimString(record.baseBranch) || "main",
		workBranch: trimString(record.workBranch),
		prompt: trimString(record.prompt),
	};
}

/** @public */
export function createRepositoryChangeParamsCodec<T extends RepositoryChangeParamsBase>(input: {
	/** @public */
	normalize(value: unknown): T;
}): Codec<T> {
	return { parse: input.normalize, serialize: (value) => value };
}

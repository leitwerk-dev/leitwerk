import { parseRepoLocator, trimString } from "@leitwerk-dev/domain";
import type { Codec } from "@leitwerk-dev/process-sdk";

export interface RepositoryChangeParamsBase {
	repoLocator: string;
	baseBranch: string;
	workBranch: string;
	prompt: string;
}

export type RepositoryChangeLaunchParams<TExtra extends object = Record<never, never>> = TExtra &
	RepositoryChangeParamsBase;

export interface NormalizedRepositoryChangeParamsInput {
	repoLocator: string;
	baseBranch: string;
	workBranch: string;
	prompt: string;
}

export function repositoryChangeParamsRecord(
	value: unknown,
	displayName: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${displayName} params must be an object`);
	}
	return value as Record<string, unknown>;
}

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

export function createRepositoryChangeParamsCodec<T extends RepositoryChangeParamsBase>(input: {
	normalize(value: unknown): T;
}): Codec<T> {
	return { parse: input.normalize, serialize: (value) => value };
}

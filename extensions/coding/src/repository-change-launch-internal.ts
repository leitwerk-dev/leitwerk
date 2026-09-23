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

/** Shared source metadata; provider-specific interfaces retain their exported names. @public */
export interface RepositoryIssueOriginParams {
	/** @public */
	origin: "issue";
	/** @public */
	issueNumber: number;
	/** @public */
	issueUrl: string;
	/** @public */
	triggerLabel: string;
	/** @public */
	doneLabel: string;
}

/** @public */
export interface RepositoryUiOriginParams {
	/** @public */
	origin: "ui";
	/** @public */
	issueNumber: null;
	/** @public */
	issueUrl: null;
	/** @public */
	triggerLabel: null;
	/** @public */
	doneLabel: null;
}

/** GitHub/Forgejo legacy origins default to issue; other providers may be stricter. @internal */
export function normalizeRepositoryIssueOrigin(
	record: Record<string, unknown>,
	displayName: string,
	text: (name: string) => string,
): RepositoryIssueOriginParams | RepositoryUiOriginParams {
	const origin = trimString(record.origin);
	if (origin === "ui") {
		return { origin: "ui", issueNumber: null, issueUrl: null, triggerLabel: null, doneLabel: null };
	}
	if (origin && origin !== "issue") throw new Error(`${displayName} requires a valid origin`);
	if (
		typeof record.issueNumber !== "number" ||
		!Number.isInteger(record.issueNumber) ||
		record.issueNumber <= 0
	)
		throw new Error(`${displayName} requires issueNumber`);
	return {
		origin: "issue",
		issueNumber: record.issueNumber,
		issueUrl: text("issueUrl"),
		triggerLabel: text("triggerLabel"),
		doneLabel: text("doneLabel"),
	};
}

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

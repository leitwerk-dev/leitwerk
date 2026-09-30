import { parseRepoLocator, trimString } from "@leitwerk-dev/domain";
import type { Codec, FormDefinition, ProcessLaunchConfig } from "@leitwerk-dev/process-sdk";
import type { RepositoryChangeWorkflow } from "./repository-change-process.js";

/** @public */
export interface RepositoryChangeOptions {
	/** @public */
	skipPlanDecision?: boolean;
	/** @public */
	skipSimplification?: boolean;
}

/** @internal */
export const repositoryChangeOptionFields: FormDefinition["fields"] = [
	{
		id: "skipPlanDecision",
		label: "Skip plan approval",
		kind: "boolean",
		description: "Generate a plan, then implement and publish automatically.",
	},
	{
		id: "skipSimplification",
		label: "Skip simplification",
		kind: "boolean",
		description: "Publish after implementation without the simplification pass.",
	},
];

/** @internal */
export function repositoryChangeOptions(input: RepositoryChangeOptions): RepositoryChangeOptions {
	return {
		skipPlanDecision: input.skipPlanDecision === true,
		skipSimplification: input.skipSimplification === true,
	};
}

/** Provider label reads happen only at the implementation route boundary. @internal */
export function repositoryChangeWorkflow<
	P extends RepositoryChangeOptions & {
		/** @internal */
		origin: string;
	},
>(readLabels: (params: P) => Promise<readonly string[]>): RepositoryChangeWorkflow<P> {
	return {
		async planDecision(params) {
			return {
				skip: params.origin === "ui" && params.skipPlanDecision === true,
				reason: "Launcher option",
			};
		},
		async simplification(params) {
			return params.origin === "ui"
				? { skip: params.skipSimplification === true, reason: "Launcher option" }
				: {
						skip: (await readLabels(params)).includes("leitwerk-skip-simplification"),
						reason: "Source labels",
					};
		},
	};
}

/** @public */
export interface RepositoryChangeParamsBase extends RepositoryChangeOptions {
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

/** Input shared by SSH-backed pull-request launchers. @public */
export interface PullRequestChangeLaunchInput
	extends Pick<RepositoryChangeParamsBase, "prompt" | "workBranch"> {
	/** @public */ profile: string;
	/** @public */ sshCredentialRef: string;
}

/** Shared launch envelope; providers retain ownership of project metadata. @internal */
export function repositoryIssueChangeLaunchConfig<
	P extends RepositoryChangeParamsBase & (RepositoryIssueOriginParams | RepositoryUiOriginParams),
>(
	provider: string,
	params: P,
	title: string,
	repository: string,
	metadata: Record<string, unknown>,
	source?: {
		/** @internal */ id?: number;
		/** @internal */ html_url: string;
		/** @internal */ ssh_url: string;
		/** @internal */ clone_url?: string;
	},
): ProcessLaunchConfig<P> {
	const issue = params.origin === "issue";
	const settingsRepository =
		source?.id !== undefined
			? {
					origin: new URL(source.html_url).origin,
					repositoryId: source.id,
					aliases: [source.ssh_url, ...(source.clone_url ? [source.clone_url] : [])],
				}
			: undefined;
	return {
		processId: `${provider}_repo_change_process`,
		params,
		title,
		startTurnId: "generate_plan",
		...(issue
			? {
					externalId: `${provider}:${repository}#${params.issueNumber}`,
					externalUrl: params.issueUrl,
				}
			: {}),
		projects: [
			{
				key: "repo",
				repoLocator: params.repoLocator,
				...(settingsRepository ? { settingsRepository } : {}),
				baseBranch: params.baseBranch,
				workBranch: params.workBranch,
				...(issue ? { externalId: String(params.issueNumber), externalUrl: params.issueUrl } : {}),
				metadata,
			},
		],
	};
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
export interface NormalizedRepositoryChangeParamsInput extends RepositoryChangeParamsBase {}

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
		...repositoryChangeOptions(record),
		repoLocator: parseRepoLocator(rawRepoLocator)?.value ?? rawRepoLocator,
		baseBranch: trimString(record.baseBranch) || "main",
		workBranch: trimString(record.workBranch),
		prompt: trimString(record.prompt),
	};
}

/** Normalize issue-capable repository params with provider-owned required text fields. @internal */
export function normalizeRepositoryIssueChangeParams<K extends string>(
	value: unknown,
	displayName: string,
	fields: readonly K[],
): NormalizedRepositoryChangeParamsInput &
	Record<K, string> &
	(RepositoryIssueOriginParams | RepositoryUiOriginParams) {
	const shared = normalizeRepositoryChangeParamsInput(value, displayName);
	const record = repositoryChangeParamsRecord(value, displayName);
	const text = (name: string) => {
		const value = trimString(record[name]);
		if (!value) throw new Error(`${displayName} requires ${name}`);
		return value;
	};
	return {
		...shared,
		...(Object.fromEntries(fields.map((name) => [name, text(name)])) as Record<K, string>),
		...normalizeRepositoryIssueOrigin(record, displayName, text),
	};
}

/** @public */
export function createRepositoryChangeParamsCodec<T extends RepositoryChangeParamsBase>(input: {
	/** @public */
	normalize(value: unknown): T;
}): Codec<T> {
	return { parse: input.normalize, serialize: (value) => value };
}

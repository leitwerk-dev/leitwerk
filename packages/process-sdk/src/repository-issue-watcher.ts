import type { LaunchModelConfigInput } from "@leitwerk-dev/domain";
import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import { parseProcessWatcherLaunchModelConfig } from "./process-watcher-source.js";
import { objectArg } from "./tool-arguments.js";

/** @public */
export interface RepositoryIssueWatcherConfig {
	/** @public */
	profile: string;
	/** @public */
	pollInterval: string;
	/** @public */
	repositories: {
		/** @public */
		include: readonly string[];
		/** @public */
		exclude: readonly string[];
	};
	/** @public */
	labels: {
		/** @public */
		trigger: string;
		/** @public */
		done: string;
	};
}

/** @public */
export function matchesRepository(
	config: Pick<RepositoryIssueWatcherConfig, "repositories">,
	repository: {
		/** @public */
		full_name: string;
	},
): boolean {
	const { include = [], exclude = [] } = config.repositories ?? {};
	return (
		!exclude.includes(repository.full_name) &&
		(include.length === 0 || include.includes(repository.full_name))
	);
}

const record = (value: unknown, subject: string) =>
	objectArg(value, `${subject} must be an object`);

function nonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "")
		throw new Error(`${path} must be a non-empty string`);
	return value.trim();
}

function repositoryNames(value: unknown, path: string): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
	return value.map((candidate, index) => {
		const name = nonEmptyString(candidate, `${path}[${index}]`);
		if (!/^[^/\s]+\/[^/\s]+$/.test(name))
			throw new Error(`${path}[${index}] must use owner/name format`);
		return name;
	});
}

/** Parse shared issue watcher fields; extensions choose the legacy type and label policy. @public */
export function parseRepositoryIssueWatcherConfig(
	raw: unknown,
	legacyType: string,
	distinctLabels = false,
): ParsedRepositoryIssueWatcherConfig {
	const config = record(raw, "watcher config");
	if (config.type !== undefined && config.type !== legacyType)
		throw new Error(`type must be '${legacyType}' when specified`);
	if (typeof config.enabled !== "boolean") throw new Error("enabled must be a boolean");
	const pollInterval = nonEmptyString(config.poll_interval, "poll_interval");
	if (parseDurationMs(pollInterval, -1, { allowHours: true }) <= 0)
		throw new Error("poll_interval must be a positive duration");
	const labels = record(config.labels, "labels");
	const repositories =
		config.repositories === undefined ? {} : record(config.repositories, "repositories");
	const parsed: RepositoryIssueWatcherConfig = {
		profile: nonEmptyString(config.profile, "profile"),
		pollInterval,
		repositories: {
			include: repositoryNames(repositories.include, "repositories.include"),
			exclude: repositoryNames(repositories.exclude, "repositories.exclude"),
		},
		labels: {
			trigger: nonEmptyString(labels.trigger, "labels.trigger"),
			done: nonEmptyString(labels.done, "labels.done"),
		},
	};
	if (distinctLabels && parsed.labels.trigger === parsed.labels.done)
		throw new Error("Trigger and done labels must differ");
	return {
		/** @public */
		config: parsed,
		/** @public */
		enabled: config.enabled,
		/** @public */
		launchModelConfig: parseProcessWatcherLaunchModelConfig(config.launch),
	};
}

/** @public */
export function presentRepositoryIssueWatcherConfig(
	config: RepositoryIssueWatcherConfig,
): RepositoryIssueWatcherPresentation {
	return {
		/** @public */
		targetSummary: `Profile ${config.profile} · trigger ${config.labels.trigger}`,
		/** @public */
		details: [
			{
				/** @public */
				label: "Profile",
				/** @public */
				value: config.profile,
			},
			{ label: "Included repositories", value: config.repositories.include.join(", ") || "all" },
			{ label: "Excluded repositories", value: config.repositories.exclude.join(", ") || "none" },
			{ label: "Trigger label", value: config.labels.trigger },
			{ label: "Done label", value: config.labels.done },
			{ label: "Poll interval", value: config.pollInterval },
		],
	};
}
/** @public */
export interface ParsedRepositoryIssueWatcherConfig {
	/** @public */
	config: RepositoryIssueWatcherConfig;
	/** @public */
	enabled: boolean;
	/** @public */
	launchModelConfig: LaunchModelConfigInput & {
		/** @public */
		skillIds: string[];
	};
}
/** @public */
export interface RepositoryIssueWatcherPresentation {
	/** @public */
	targetSummary: string;
	/** @public */
	details: {
		/** @public */
		label: string;
		/** @public */
		value: string;
	}[];
}

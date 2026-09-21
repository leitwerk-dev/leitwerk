import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import { parseProcessWatcherLaunchModelConfig } from "./process-watcher-source.js";
import { objectArg } from "./tool-arguments.js";

/** @public */
export interface RepositoryIssueWatcherConfig {
	/** @internal */
	profile: string;
	/** @internal */
	pollInterval: string;
	/** @internal */
	repositories: {
		/** @internal */
		include: readonly string[];
		/** @internal */
		exclude: readonly string[];
	};
	/** @internal */
	labels: {
		/** @internal */
		trigger: string;
		/** @internal */
		done: string;
	};
}

/** @internal */
export function matchesRepository(
	config: Pick<RepositoryIssueWatcherConfig, "repositories">,
	repository: {
		/** @internal */
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

/** Parse shared issue watcher fields; extensions choose the legacy type and label policy. @internal */
export function parseRepositoryIssueWatcherConfig(
	raw: unknown,
	legacyType: string,
	distinctLabels = false,
) {
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
		/** @internal */
		config: parsed,
		/** @internal */
		enabled: config.enabled,
		/** @internal */
		launchModelConfig: parseProcessWatcherLaunchModelConfig(config.launch),
	};
}

/** @internal */
export function presentRepositoryIssueWatcherConfig(config: RepositoryIssueWatcherConfig) {
	return {
		/** @internal */
		targetSummary: `Profile ${config.profile} · trigger ${config.labels.trigger}`,
		/** @internal */
		details: [
			{
				/** @internal */
				label: "Profile",
				/** @internal */
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

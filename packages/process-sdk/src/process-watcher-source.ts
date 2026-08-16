import type { LaunchModelConfigInput } from "@leitwerk-dev/domain";
import type { ProcessWatcherSource } from "./extension-api.js";

function record(value: unknown, subject: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${subject} must be an object`);
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value;
}

/** Parse the shared launch-model fragment nested inside extension-owned watcher config. */
export function parseProcessWatcherLaunchModelConfig(
	value: unknown,
): LaunchModelConfigInput & { skillIds: string[] } {
	if (value === undefined) return { defaultModelProfileId: null, turnConfigs: {}, skillIds: [] };
	const launch = record(value, "launch");
	const rawSkills = launch.skills === undefined ? [] : launch.skills;
	if (!Array.isArray(rawSkills)) throw new Error("launch.skills must be an array");
	const skillIds = rawSkills.map((skill, index) => nonEmptyString(skill, `launch.skills.${index}`));
	if (new Set(skillIds).size !== skillIds.length)
		throw new Error("launch.skills contains duplicates");
	const rawTurns =
		launch.turn_configs === undefined ? {} : record(launch.turn_configs, "launch.turn_configs");
	return {
		defaultModelProfileId:
			launch.default_model_profile === undefined
				? null
				: nonEmptyString(launch.default_model_profile, "launch.default_model_profile"),
		turnConfigs: Object.fromEntries(
			Object.entries(rawTurns).map(([turnId, value]) => {
				const turn = record(value, `launch.turn_configs.${turnId}`);
				return [
					turnId,
					{
						modelProfileId:
							turn.model_profile === undefined
								? null
								: nonEmptyString(turn.model_profile, `launch.turn_configs.${turnId}.model_profile`),
					},
				];
			}),
		),
		skillIds,
	};
}

export function defineProcessWatcherSource<TConfig, TEvent = unknown>(
	source: ProcessWatcherSource<TConfig, TEvent>,
): ProcessWatcherSource<TConfig, TEvent> {
	if (source.id.trim() === "") {
		throw new Error("Process watcher source id must not be empty");
	}
	if (source.label.trim() === "") {
		throw new Error(`Process watcher source '${source.id}' must define a non-empty label`);
	}
	return source;
}

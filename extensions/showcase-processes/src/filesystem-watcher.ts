import type {
	CoreServerSetupDeps,
	LaunchModelConfigInputLike,
	ServerExtensionLogger,
} from "@leitwerk-dev/process-sdk";
import { defineProcessWatcherSource } from "@leitwerk-dev/process-sdk";
import {
	consumeTriggerFile,
	createPollLoop,
	emptyPollResult,
	parseDurationMs,
	readTriggerFile,
} from "@leitwerk-dev/watcher-utils";

export interface FilesystemWatcherEvent {
	filePath: string;
	content: string;
}

export interface FilesystemWatcherConfig {
	enabled: boolean;
	pollInterval: string;
	filePath: string;
}

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

function parseLaunchModelConfig(value: unknown): LaunchModelConfigInputLike {
	if (value === undefined) return { defaultModelProfileId: null, turnConfigs: {} };
	const launch = record(value, "launch");
	const rawTurnConfigs =
		launch.turn_configs === undefined ? {} : record(launch.turn_configs, "launch.turn_configs");
	const turnConfigs = Object.fromEntries(
		Object.entries(rawTurnConfigs).map(([turnId, raw]) => {
			const turn = record(raw, `launch.turn_configs.${turnId}`);
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
	);
	return {
		defaultModelProfileId:
			launch.default_model_profile === undefined
				? null
				: nonEmptyString(launch.default_model_profile, "launch.default_model_profile"),
		turnConfigs,
	};
}

export const filesystemWatcherSource = defineProcessWatcherSource<
	FilesystemWatcherConfig,
	FilesystemWatcherEvent
>({
	id: "@leitwerk-dev/showcase-processes.file",
	label: "File",
	parseConfig(raw) {
		const config = record(raw, "watcher config");
		if (config.type !== undefined && config.type !== "filesystem") {
			throw new Error("type must be 'filesystem' when specified");
		}
		if (typeof config.enabled !== "boolean") {
			throw new Error("enabled must be a boolean");
		}
		const pollInterval = nonEmptyString(config.poll_interval, "poll_interval");
		if (parseDurationMs(pollInterval, -1, { allowHours: true }) <= 0) {
			throw new Error("poll_interval must be a positive duration");
		}
		return {
			config: {
				enabled: config.enabled,
				pollInterval,
				filePath: nonEmptyString(config.file_path, "file_path"),
			},
			enabled: config.enabled,
			launchModelConfig: parseLaunchModelConfig(config.launch),
		};
	},
	presentConfig(config) {
		return {
			targetSummary: `File ${config.filePath}`,
			details: [
				{ label: "File path", value: config.filePath, format: "code" },
				{ label: "Poll interval", value: config.pollInterval },
			],
		};
	},
});

export function createFilesystemWatcherProvider(
	deps: CoreServerSetupDeps,
	logger?: ServerExtensionLogger,
) {
	const watchers = deps.processWatchers?.listBySource(filesystemWatcherSource) ?? [];
	const loops = watchers.map((watcher) =>
		createPollLoop({
			pollInterval: () => watcher.config.pollInterval,
			isEnabled: () => watcher.enabled,
			defaultIntervalMs: 1_000,
			async pollOnce() {
				const result = emptyPollResult();
				const file = await readTriggerFile(watcher.config.filePath);
				if (!file.exists || file.content.trim() === "") return result;
				const resolved = await watcher.resolveLaunch({
					filePath: watcher.config.filePath,
					content: file.content.trim(),
				});
				if (!resolved) {
					result.skipped.push(`${watcher.processId}:${watcher.watcherId}`);
					return result;
				}
				const prepared = await deps.launchPlans.prepare(resolved.launchPlan, {
					modelConfig: watcher.launchModelConfig,
					invalidModelConfig: "omit",
				});
				if (!prepared.ok) {
					result.errors.push(
						...prepared.errors.map(
							(error) => `${watcher.processId}:${watcher.watcherId}:${error.code}`,
						),
					);
					return result;
				}
				const created = await deps.processLaunches.createProcessFromLaunchPlan(prepared.launchPlan);
				const durableProcess = created.ok
					? created.process
					: created.stage === "post_commit"
						? created.process
						: null;
				if (durableProcess) {
					await consumeTriggerFile(watcher.config.filePath);
					result.created.push(durableProcess.id);
				}
				if (!created.ok) {
					result.errors.push(
						`${watcher.processId}:${watcher.watcherId}:${created.status}:${String(created.body.error ?? "launch_failed")}`,
					);
					logger?.warn?.(
						{
							processId: watcher.processId,
							watcherId: watcher.watcherId,
							filePath: watcher.config.filePath,
							status: created.status,
						},
						"File watcher launch failed",
					);
				}
				return result;
			},
		}),
	);
	return {
		start() {
			for (const loop of loops) loop.start();
		},
		stop() {
			for (const loop of loops) loop.stop();
		},
	};
}

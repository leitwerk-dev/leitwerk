import { createHash } from "node:crypto";
import type { CoreServerSetupDeps } from "@leitwerk-dev/process-sdk";
import {
	defineProcessWatcherSource,
	parseProcessWatcherLaunchModelConfig,
} from "@leitwerk-dev/process-sdk";
import {
	consumeTriggerFile,
	emptyPollResult,
	parseDurationMs,
	readTriggerFile,
} from "@leitwerk-dev/watcher-utils";

export interface FilesystemWatcherEvent {
	filePath: string;
	content: string;
}

export interface FilesystemWatcherConfig {
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
				pollInterval,
				filePath: nonEmptyString(config.file_path, "file_path"),
			},
			enabled: config.enabled,
			launchModelConfig: parseProcessWatcherLaunchModelConfig(config.launch),
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

export function createFilesystemWatcherProvider(deps: CoreServerSetupDeps) {
	const watchers = deps.processWatchers?.listBySource(filesystemWatcherSource) ?? [];
	const pollers = watchers.map((watcher) =>
		deps.polling.create({
			id: `showcase-filesystem:${watcher.processId}:${watcher.watcherId}`,
			pollInterval: () => watcher.config.pollInterval,
			isEnabled: () => watcher.enabled,
			defaultIntervalMs: 1_000,
			async pollOnce() {
				const result = emptyPollResult();
				const file = await readTriggerFile(watcher.config.filePath);
				if (!file.exists || file.content.trim() === "") return result;
				const content = file.content.trim();
				const sourceEventKey = createHash("sha256")
					.update(`${watcher.config.filePath}\0${content}`)
					.digest("hex");
				const launched = await deps.launchRuns.startWatcher(
					watcher,
					{ filePath: watcher.config.filePath, content },
					{
						idempotencyKey: `showcase-filesystem:${watcher.processId}:${watcher.watcherId}:${sourceEventKey}`,
					},
				);
				if (launched.process) {
					await consumeTriggerFile(watcher.config.filePath);
					result.created.push(launched.process.id);
				}
				if (launched.error) {
					result.errors.push(`${watcher.processId}:${watcher.watcherId}:${launched.error}`);
				} else if (!launched.process) {
					result.skipped.push(`${watcher.processId}:${watcher.watcherId}`);
				}
				return result;
			},
		}),
	);
	return { pollers };
}

import type { ProcessLaunchPlanServiceLike } from "@leitwerk-dev/process-sdk";
import {
	consumeTriggerFile,
	createPollLoop,
	emptyPollResult,
	type PollLoop,
	readTriggerFile,
} from "@leitwerk-dev/watcher-utils";
import type { FastifyBaseLogger } from "fastify";
import type { ProcessLaunchExecutorDeps } from "./process-launch-executor.js";
import { createProcessFromLaunchPlan } from "./process-launch-executor.js";

interface FilesystemWatcherRegistration {
	processId: string;
	watcherId: string;
	enabled: boolean;
	pollInterval: string;
	config: { type: "filesystem"; file_path: string };
	launchModelConfig: {
		defaultModelProfileId?: string | null;
		turnConfigs?: Record<string, { modelProfileId?: string | null }>;
	};
}

interface FilesystemWatcherStartResult {
	launchPlan: import("@leitwerk-dev/process-sdk").ProcessLaunchPlan;
}

interface FilesystemWatcherServiceLike {
	listByType(type: "filesystem"): readonly unknown[];
	resolveLaunch(
		processId: string,
		watcherId: string,
		payload: unknown,
	): Promise<FilesystemWatcherStartResult | null>;
}

export interface FilesystemProcessWatchersService {
	start(): void;
	stop(): void;
}

export function createFilesystemProcessWatchersService(args: {
	processWatchers: FilesystemWatcherServiceLike;
	launchPlans: ProcessLaunchPlanServiceLike;
	launchExecutorDeps: ProcessLaunchExecutorDeps;
	logger?: FastifyBaseLogger;
}): FilesystemProcessWatchersService {
	const watchers = args.processWatchers.listByType(
		"filesystem",
	) as readonly FilesystemWatcherRegistration[];
	const loops: PollLoop[] = watchers.map((watcher: FilesystemWatcherRegistration) =>
		createPollLoop({
			pollInterval: () => watcher.pollInterval,
			isEnabled: () => watcher.enabled,
			defaultIntervalMs: 1_000,
			async pollOnce() {
				const result = emptyPollResult();
				if (watcher.config.type !== "filesystem") {
					return result;
				}
				const file = await readTriggerFile(watcher.config.file_path);
				if (!file.exists) {
					return result;
				}
				const content = file.content.trim();
				if (content.length === 0) {
					return result;
				}
				const resolved = await args.processWatchers.resolveLaunch(
					watcher.processId,
					watcher.watcherId,
					{ filePath: watcher.config.file_path, content },
				);
				if (!resolved) {
					result.skipped.push(`${watcher.processId}:${watcher.watcherId}`);
					return result;
				}
				const prepared = await args.launchPlans.prepare(resolved.launchPlan, {
					modelConfig: watcher.launchModelConfig,
					invalidModelConfig: "omit",
				});
				if (!prepared.ok) {
					result.errors.push(
						...prepared.errors.map(
							(error) => `${watcher.processId}:${watcher.watcherId}:${error.code}`,
						),
					);
					args.logger?.warn(
						{
							processId: watcher.processId,
							watcherId: watcher.watcherId,
							filePath: watcher.config.file_path,
							errors: prepared.errors,
						},
						"Filesystem process watcher launch plan preparation failed",
					);
					return result;
				}
				const created = await createProcessFromLaunchPlan(
					args.launchExecutorDeps,
					prepared.launchPlan,
				);
				const durableProcess = created.ok
					? created.process
					: created.stage === "post_commit"
						? created.process
						: null;
				if (durableProcess) {
					await consumeTriggerFile(watcher.config.file_path);
					result.created.push(durableProcess.id);
				}
				if (!created.ok) {
					result.errors.push(
						`${watcher.processId}:${watcher.watcherId}:${created.status}:${String(created.body.error ?? "launch_failed")}`,
					);
					args.logger?.warn(
						{
							processId: watcher.processId,
							watcherId: watcher.watcherId,
							filePath: watcher.config.file_path,
							status: created.status,
							body: created.body,
							durableProcessId: durableProcess?.id ?? null,
						},
						"Filesystem process watcher launch failed",
					);
					return result;
				}
				return result;
			},
		}),
	);

	return {
		start() {
			for (const loop of loops) {
				loop.start();
			}
		},
		stop() {
			for (const loop of loops) {
				loop.stop();
			}
		},
	};
}

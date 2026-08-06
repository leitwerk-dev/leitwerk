import type { InstanceTurnConfigInput } from "@leitwerk-dev/domain";
import type {
	WatcherLaunchModelSummary,
	WatcherSummary,
	WatchersResponseBody,
} from "@leitwerk-dev/protocol/http-contracts";
import type { FastifyInstance } from "fastify";
import type {
	ProcessWatcherServiceLike,
	RegisteredProcessWatcherLike,
} from "../process-watcher-registry.js";

export interface WatcherRouteDeps {
	processWatchers?: ProcessWatcherServiceLike;
}

function summarizeLaunchModelConfig(
	modelConfig: RegisteredProcessWatcherLike["launchModelConfig"],
): WatcherLaunchModelSummary {
	const isTurnConfigEntry = (
		entry: [string, unknown],
	): entry is [string, InstanceTurnConfigInput] => {
		const value = entry[1];
		return (
			typeof value === "object" &&
			value !== null &&
			"modelProfileId" in value &&
			typeof value.modelProfileId === "string"
		);
	};
	return {
		defaultModelProfileId: modelConfig.defaultModelProfileId ?? null,
		turnConfigs: Object.entries(modelConfig.turnConfigs ?? {})
			.filter(isTurnConfigEntry)
			.map(([turnId, turnConfig]) => ({
				turnId,
				modelProfileId: turnConfig.modelProfileId ?? null,
			}))
			.sort((a, b) => a.turnId.localeCompare(b.turnId)),
	};
}

function buildWatcherSummary(watcher: RegisteredProcessWatcherLike): WatcherSummary {
	const launchModel = summarizeLaunchModelConfig(watcher.launchModelConfig);
	switch (watcher.config.type) {
		case "jira":
			return {
				processId: watcher.processId,
				processDisplayName: watcher.processDisplayName,
				watcherId: watcher.watcherId,
				label: watcher.watcherLabel,
				description: watcher.watcherDescription,
				type: "jira",
				enabled: watcher.enabled,
				pollInterval: watcher.pollInterval,
				configPath: watcher.configPath,
				launchModel,
				targetSummary: `Jira project ${watcher.config.project} · trigger ${watcher.config.labels.trigger}`,
				project: watcher.config.project,
				labels: watcher.config.labels,
				targetBranchLabelPrefix: watcher.config.target_branch_label_prefix,
			};
		case "gitlab_mr":
			return {
				processId: watcher.processId,
				processDisplayName: watcher.processDisplayName,
				watcherId: watcher.watcherId,
				label: watcher.watcherLabel,
				description: watcher.watcherDescription,
				type: "gitlab_mr",
				enabled: watcher.enabled,
				pollInterval: watcher.pollInterval,
				configPath: watcher.configPath,
				launchModel,
				targetSummary: `GitLab group ${watcher.config.group} · trigger ${watcher.config.labels.trigger}`,
				group: watcher.config.group,
				labels: watcher.config.labels,
			};
		case "filesystem":
			return {
				processId: watcher.processId,
				processDisplayName: watcher.processDisplayName,
				watcherId: watcher.watcherId,
				label: watcher.watcherLabel,
				description: watcher.watcherDescription,
				type: "filesystem",
				enabled: watcher.enabled,
				pollInterval: watcher.pollInterval,
				configPath: watcher.configPath,
				launchModel,
				targetSummary: `File ${watcher.config.file_path}`,
				filePath: watcher.config.file_path,
			};
	}
}

export function registerWatcherRoutes(app: FastifyInstance, deps: WatcherRouteDeps): void {
	app.get("/api/watchers", async () => {
		const watchers = deps.processWatchers?.listAll() ?? [];
		const body = {
			watchers: watchers.map(buildWatcherSummary),
		} satisfies WatchersResponseBody;
		return body;
	});
}

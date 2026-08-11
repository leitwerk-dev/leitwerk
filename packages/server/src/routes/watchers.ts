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
	return {
		processId: watcher.processId,
		processDisplayName: watcher.processDisplayName,
		watcherId: watcher.watcherId,
		label: watcher.watcherLabel,
		description: watcher.watcherDescription,
		sourceId: watcher.sourceId,
		sourceLabel: watcher.sourceLabel,
		enabled: watcher.enabled,
		configPath: watcher.configPath,
		launchModel,
		targetSummary: watcher.presentation.targetSummary,
		details: [...(watcher.presentation.details ?? [])],
	};
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

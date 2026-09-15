import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	type CoreServerSetupDeps,
	createExternalSourcePollReporter,
} from "@leitwerk-dev/process-sdk";
import { createPollSchedule, emptyPollResult } from "@leitwerk-dev/watcher-utils";
import type { WoodpeckerClientLike, WoodpeckerIntegration } from "./capability.js";
import { WOODPECKER_PIPELINE_KIND, type WoodpeckerPipelineSourceConfig } from "./external.js";

function parse(value: unknown): WoodpeckerPipelineSourceConfig | null {
	const config = asUnknownRecord(value) ?? {};
	if (
		["profile", "owner", "repo", "branch", "headSha"].some(
			(key) => typeof config[key] !== "string" || !(config[key] as string).trim(),
		)
	)
		return null;
	return {
		profile: config.profile as string,
		owner: config.owner as string,
		repo: config.repo as string,
		branch: config.branch as string,
		headSha: config.headSha as string,
		afterPipelineNumber:
			typeof config.afterPipelineNumber === "number" ? config.afterPipelineNumber : 0,
		disabled: config.disabled === true,
		pollInterval: typeof config.pollInterval === "string" ? config.pollInterval : "30s",
		statuses: Array.isArray(config.statuses)
			? config.statuses.filter((value): value is string => typeof value === "string")
			: undefined,
	};
}
const terminal = new Set([
	"success",
	"failure",
	"error",
	"killed",
	"canceled",
	"cancelled",
	"declined",
	"blocked",
]);
const supportedEvents = new Set(["push", "pull_request", "pull_request_closed"]);

function matchesBranch(event: string, pipelineBranch: string, sourceBranch: string): boolean {
	// Woodpecker reports the PR target branch in `branch`. The commit uniquely
	// identifies the watched source head, so branch filtering only applies to pushes.
	return event !== "push" || pipelineBranch === sourceBranch;
}

export function createWoodpeckerProvider(
	deps: CoreServerSetupDeps,
	integration: WoodpeckerIntegration,
	options: { now?: () => number } = {},
) {
	const due = createPollSchedule(options.now);
	return deps.polling.create({
		id: "woodpecker",
		pollInterval: () => "5s",
		isEnabled: () => true,
		defaultIntervalMs: 5_000,
		async pollOnce() {
			const result = emptyPollResult();
			const report = createExternalSourcePollReporter(deps.externalSources, result);
			await report.poll(WOODPECKER_PIPELINE_KIND, async (armed) => {
				const config = parse(armed.resolved);
				if (!config) {
					result.errors.push(`${armed.id}:invalid_config`);
					return;
				}
				if (config.disabled) return;
				const key = `${armed.instanceId}:${armed.id}`;
				if (!due(key, config.pollInterval)) return;
				const client = integration.client(config.profile);
				const repo = await client.lookupRepository(`${config.owner}/${config.repo}`);
				const pipeline = await findLatestPipeline(client, repo.id, config);
				if (
					!pipeline ||
					!terminal.has(pipeline.status) ||
					(config.statuses && !config.statuses.includes(pipeline.status))
				)
					return;
				await report.fire(
					armed,
					{ repositoryId: repo.id, pipeline },
					`${pipeline.number}:${pipeline.status}`,
				);
			});
			return result;
		},
	});
}

/** The bounded lookup reports incomplete history instead of waiting silently. */
export async function findLatestPipeline(
	client: WoodpeckerClientLike,
	repoId: number,
	config: WoodpeckerPipelineSourceConfig,
) {
	for (let page = 1; page <= 10; page++) {
		const pipelines = (await client.listPipelines(repoId, undefined, { page, perPage: 100 })).sort(
			(a, b) => b.number - a.number,
		);
		const match = pipelines.find(
			(candidate) =>
				candidate.number > (config.afterPipelineNumber ?? 0) &&
				candidate.commit === config.headSha &&
				supportedEvents.has(candidate.event) &&
				matchesBranch(candidate.event, candidate.branch, config.branch),
		);
		if (match) return match;
		if (
			pipelines.length < 100 ||
			pipelines.some((candidate) => candidate.number <= (config.afterPipelineNumber ?? 0))
		)
			return null;
	}
	throw new Error(
		"Woodpecker pipeline lookup window exhausted (1000 pipelines); inspect the repository and update the watched pipeline floor before retrying",
	);
}

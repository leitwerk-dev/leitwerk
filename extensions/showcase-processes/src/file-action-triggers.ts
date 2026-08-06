import type { CoreServerSetupDeps } from "@leitwerk-dev/process-sdk";
import {
	consumeTriggerFile,
	createPollLoop,
	emptyPollResult,
	type PollResult,
	readTriggerFile,
} from "@leitwerk-dev/watcher-utils";
import { poemCreatorActionIds } from "./turns/poem-creator.js";

export interface SinglePromptFileTriggerConfig {
	poll_interval: string;
	poem_review_path: string;
	complete_prompt_path: string;
}

function findEligiblePoemReviewInstanceIds(deps: CoreServerSetupDeps): string[] {
	return deps.processes
		.listAll()
		.filter(
			(process) =>
				process.processId === "poem_creator_process" &&
				process.selectedTurnId === "poem_review" &&
				process.lifecycleStatus === "waiting",
		)
		.map((process) => process.id);
}

async function processPoemReviewTrigger(
	deps: CoreServerSetupDeps,
	config: SinglePromptFileTriggerConfig,
	eligibleInstanceIds: readonly string[],
	result: PollResult,
): Promise<void> {
	const file = await readTriggerFile(config.poem_review_path);
	if (!file.exists) {
		return;
	}
	const message = file.content.trim();
	if (message.length === 0) {
		return;
	}
	if (eligibleInstanceIds.length !== 1) {
		result.skipped.push(`poem_review:${eligibleInstanceIds.length}`);
		return;
	}
	const instanceId = eligibleInstanceIds[0];
	if (!instanceId) {
		return;
	}
	const action = await deps.processActions.executeAction(
		instanceId,
		poemCreatorActionIds.requestRevision,
		{ message },
		{ source: "external" },
	);
	if (!action.ok) {
		result.errors.push(
			`poem_review:${instanceId}:${action.code ?? action.error ?? "external_action_failed"}`,
		);
		deps.events.create({
			instanceId,
			eventType: "external_source_failed",
			data: {
				kind: "@leitwerk-dev/showcase-processes.file.instruction",
				path: config.poem_review_path,
				message: action.code ?? action.error,
			},
		});
		return;
	}
	deps.events.create({
		instanceId,
		eventType: "external_source_consumed",
		data: {
			kind: "@leitwerk-dev/showcase-processes.file.instruction",
			path: config.poem_review_path,
		},
	});
	await consumeTriggerFile(config.poem_review_path);
	result.created.push(`poem_review:${instanceId}`);
}

export function createSinglePromptFileTriggerLoop(
	deps: CoreServerSetupDeps,
	config: SinglePromptFileTriggerConfig,
) {
	const armed = new Set<string>();
	return createPollLoop({
		pollInterval: () => config.poll_interval,
		isEnabled: () => true,
		defaultIntervalMs: 1_000,
		async pollOnce() {
			const result = emptyPollResult();
			const eligible = findEligiblePoemReviewInstanceIds(deps);
			for (const instanceId of eligible) {
				if (!armed.has(instanceId)) {
					deps.events.create({
						instanceId,
						eventType: "external_trigger_listener_armed",
						data: {
							trigger: "poem_review_file",
							actionId: poemCreatorActionIds.requestRevision,
							path: config.poem_review_path,
							pollInterval: config.poll_interval,
						},
					});
					armed.add(instanceId);
				}
			}
			for (const instanceId of [...armed]) {
				if (!eligible.includes(instanceId)) {
					armed.delete(instanceId);
				}
			}
			await processPoemReviewTrigger(deps, config, eligible, result);
			return result;
		},
	});
}

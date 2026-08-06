import {
	COMMIT_MESSAGE_PROJECT_METADATA_KEY,
	type ExtensionProcessDefinition,
	type ProcessLaunchConfig,
	type ProcessLaunchPlan,
} from "@leitwerk-dev/process-sdk";
import { resolveCommitMessageMetadata } from "./commit-message-policy.js";
import type { CommitMessageConfig } from "./config/config-types.js";
import { normalizeProcessTitleInput } from "./launch-title.js";

export interface BuildProcessLaunchPlanInput {
	processDef: ExtensionProcessDefinition;
	launchConfig: ProcessLaunchConfig;
	launcherId: string;
	metadataAdditions?: Record<string, unknown>;
	errorSubject?: string;
	commitMessages?: CommitMessageConfig;
}

function serializeJson(value: unknown): string | null {
	const serialized = JSON.stringify(value);
	return serialized ?? null;
}

function normalizeProjectInputs(
	launchConfig: ProcessLaunchConfig,
	commitMessages?: CommitMessageConfig,
): ProcessLaunchPlan["projectInputs"] {
	return (launchConfig.projects ?? []).map((project) => ({
		key: project.key,
		repoLocator: project.repoLocator,
		baseBranch: project.baseBranch,
		workBranch: project.workBranch ?? null,
		externalId: project.externalId ?? null,
		externalUrl: project.externalUrl ?? null,
		metadata: {
			...(project.metadata ?? {}),
			[COMMIT_MESSAGE_PROJECT_METADATA_KEY]: resolveCommitMessageMetadata(
				project.repoLocator,
				commitMessages,
			),
		},
	}));
}

export function buildProcessLaunchPlan(input: BuildProcessLaunchPlanInput): ProcessLaunchPlan {
	if (input.launchConfig.processId !== input.processDef.id) {
		const subject = input.errorSubject ?? `Launcher '${input.launcherId}'`;
		throw new Error(
			`${subject} resolved processId '${input.launchConfig.processId}', expected '${input.processDef.id}'`,
		);
	}

	const processDef = input.processDef as ExtensionProcessDefinition<unknown, unknown>;
	const params = processDef.paramsCodec.parse(input.launchConfig.params);
	const paramsJson = serializeJson(processDef.paramsCodec.serialize(params));
	const initialState = processDef.initialState(params);
	const state = processDef.stateCodec.parse(initialState);
	const stateJson = serializeJson(processDef.stateCodec.serialize(state));
	const launchMetadata = {
		...(input.launchConfig.metadata ?? {}),
		...(input.metadataAdditions ?? {}),
	};

	return {
		launcherId: input.launcherId,
		processId: input.processDef.id,
		processInput: {
			processId: input.processDef.id,
			selectedTurnId: null,
			lifecycleStatus: "discovered",
			title: normalizeProcessTitleInput(input.launchConfig.title ?? null),
			externalId: input.launchConfig.externalId ?? null,
			externalUrl: input.launchConfig.externalUrl ?? null,
			metadata: launchMetadata,
			defaultModelProfileId: input.launchConfig.defaultModelProfileId ?? null,
			turnConfigsJson: input.launchConfig.turnConfigs
				? JSON.stringify(input.launchConfig.turnConfigs)
				: null,
			selectedTurnModelProfileId: null,
			selectedTurnModelKind: null,
			selectedTurnModelSource: null,
			paramsJson,
			stateJson,
		},
		titleSourceFields: input.launchConfig.titleSourceFields?.map((field) => ({ ...field })),
		projectInputs: normalizeProjectInputs(input.launchConfig, input.commitMessages),
		startTurnId: input.launchConfig.startTurnId ?? null,
	};
}

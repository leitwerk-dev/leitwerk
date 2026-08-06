import type { ProcessInstance, ProcessTurnRecord, TurnStartRecord } from "@leitwerk-dev/domain";
import type { ProcessLaunchPlan } from "@leitwerk-dev/process-sdk";
import { getDefaultConfig } from "../config/config-loader.js";
import type { LeitwerkConfig } from "../config/config-types.js";
import type { ServerProcessModelPolicy } from "../process-model-policy/index.js";
import { createServerProcessModelPolicy } from "../process-model-policy/index.js";
import { createFixtureProcess, createProcessGraphRegistry } from "./process-fixtures.js";
import { createTestLlmTurn } from "./turn-fixtures.js";

type TestLaunchPlanOverrides = Omit<Partial<ProcessLaunchPlan>, "processInput"> & {
	processInput?: Partial<ProcessLaunchPlan["processInput"]>;
};

export function createTestLaunchPlan(overrides: TestLaunchPlanOverrides = {}): ProcessLaunchPlan {
	const processInput: ProcessLaunchPlan["processInput"] = {
		processId: "policy",
		selectedTurnId: "run",
		lifecycleStatus: "discovered",
		paramsJson: null,
		stateJson: null,
		turnConfigsJson: null,
		...overrides.processInput,
	};
	return {
		launcherId: "policy.launcher",
		processId: "policy",
		projectInputs: [],
		startTurnId: "run",
		...overrides,
		processInput,
	};
}

export function createTestProcessInstance(
	overrides: Partial<ProcessInstance> = {},
): ProcessInstance {
	return {
		id: "p",
		processId: "policy",
		selectedTurnId: "run",
		lifecycleStatus: "active",
		currentExecution: null,
		planRevision: 0,
		title: null,
		externalId: null,
		externalUrl: null,
		metadata: null,
		defaultModelProfileId: null,
		turnConfigsJson: null,
		selectedTurnModelProfileId: null,
		selectedTurnModelKind: null,
		selectedTurnModelSource: null,
		paramsJson: null,
		stateJson: null,
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

export function createTestTurnRecord(
	overrides: Partial<ProcessTurnRecord> = {},
): ProcessTurnRecord {
	return {
		id: "t1",
		instanceId: "p",
		turnId: "run",
		turnType: "llm",
		status: "succeeded",
		attemptNumber: 1,
		parentTurnRecordId: null,
		turnStartRecordId: "s1",
		acceptedWorkerLeaseId: "lease1",
		pathType: "primary",
		forkPiEntryId: null,
		resultPiEntryId: "result",
		modelProfileId: "first",
		turnResultMarkdown: null,
		errorSummary: null,
		errorClass: null,
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:01:00.000Z",
		...overrides,
	};
}

type Availability = "available" | "unavailable" | "stale";
export function createModelAvailabilitySnapshot(
	profiles: readonly {
		profileId: string;
		providerId?: string;
		modelId?: string;
		availability?: Availability;
	}[] = [
		{ profileId: "first", modelId: "one" },
		{ profileId: "second", modelId: "two" },
	],
	revision = 1,
) {
	return {
		revision,
		capturedAt: "2026-01-01T00:00:00.000Z",
		availabilityTransitions: [],
		profiles: profiles.map((profile) => ({
			profileId: profile.profileId,
			providerId: profile.providerId ?? "test",
			modelId: profile.modelId ?? profile.profileId,
			availability: profile.availability ?? "available",
			checkedAt: null,
			expiresAt: null,
		})),
	} as const;
}

export function createTestModelPolicy(
	input: {
		profiles?: readonly {
			id: string;
			model_id?: string;
			provider_options?: Record<string, unknown>;
		}[];
		processDefaultProfileId?: string;
		processTurnProfileId?: string;
		modelPurpose?: boolean;
		purposeProfileId?: string;
		allowedProfileIds?: readonly string[];
	} = {},
): {
	config: LeitwerkConfig;
	policy: ServerProcessModelPolicy;
	graph: ReadonlyMap<string, unknown>;
	processActionRegistry: { getTurnDefinition: () => ReturnType<typeof createTestLlmTurn> };
} {
	const config = getDefaultConfig();
	config.pi.model_profiles = (
		input.profiles ?? [
			{ id: "first", model_id: "one" },
			{ id: "second", model_id: "two" },
		]
	).map((profile) => ({
		id: profile.id,
		provider: "test",
		model_id: profile.model_id ?? profile.id,
		...(profile.provider_options ? { provider_options: profile.provider_options as never } : {}),
	}));
	config.pi.process_title_generation.model_profile = input.purposeProfileId ?? null;
	config.process_configs = {
		policy: {
			allowed_model_profiles: [
				...(input.allowedProfileIds ?? config.pi.model_profiles.map((profile) => profile.id)),
			],
			...(input.processDefaultProfileId
				? { default_model_profile: input.processDefaultProfileId }
				: {}),
			turn_configs: input.processTurnProfileId
				? { run: { model_profile: input.processTurnProfileId } }
				: {},
		},
	};
	const turn = createTestLlmTurn<string, Record<string, never>, Record<string, never>>(
		"run",
		{},
		{
			...(input.modelPurpose || input.purposeProfileId !== undefined
				? { modelPurpose: "process_title_generation" as const }
				: {}),
		},
	);
	const graph = createProcessGraphRegistry([
		createFixtureProcess({ id: "policy", entry: "run", turns: { run: turn } }) as never,
	]);
	const processActionRegistry = { getTurnDefinition: () => turn as never };
	return {
		config,
		graph,
		processActionRegistry,
		policy: createServerProcessModelPolicy({ config, processGraphs: graph, processActionRegistry }),
	};
}

export function createTestTurnStart(overrides: Partial<TurnStartRecord> = {}): TurnStartRecord {
	return {
		id: "s1",
		instanceId: "p",
		turnId: "run",
		turnType: "llm",
		proposedTurnRecordId: "t1",
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "starting",
			start: {
				kind: "llm",
				model: { profileId: "first", providerId: "test", modelId: "one", thinkingLevel: "off" },
				modelSelectionProvenance: { kind: "inherited", source: "catalog_default" },
				availabilityRevision: 1,
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: "digest",
				workerRuntimeProfileId: "local",
				piSettings: {},
			},
		},
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

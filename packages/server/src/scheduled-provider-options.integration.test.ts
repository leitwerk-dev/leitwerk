import { defineModelProvider, defineProviderOptions } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import { createModelStatusCache } from "./model-providers/model-status-cache.js";
import { createModelProviderRegistry } from "./model-providers/registry.js";
import { createPiResourceBundleCache } from "./pi-resources/index.js";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { createProcessEngine } from "./process-engine/engine.js";
import { prepareCreatedTurnStarts } from "./process-engine/turn-start-preflight.js";
import { createServerProcessModelPolicy } from "./process-model-policy/index.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createFakeWorkerSupervisor } from "./test-helpers/fake-worker-supervisor.js";
import { ownedProviderSet } from "./test-helpers/model-provider-fixtures.js";
import { createDefaultTestProcessGraphRegistry } from "./test-helpers/process-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

function setup(options: { defaultAccount?: () => string | undefined } = {}) {
	const deps = createTestDeps();
	const config = getDefaultConfig();
	config.pi.model_profiles = [
		{ id: "scheduled-model", provider: "scheduled-provider", model_id: "scheduled-model" },
	];
	const definition = defineModelProvider({
		id: "scheduled-provider",
		parseConfig: () => ({ config: {} }),
		worker: { kind: "builtin_pi_provider", provider: "scheduled-provider" },
		models: async () => [{ modelId: "scheduled-model", availability: "available" }],
		options: defineProviderOptions({
			fields: {
				account: {
					label: "Account",
					required: true,
					...(options.defaultAccount ? { defaultValue: options.defaultAccount } : {}),
				},
			},
		}),
		secrets: () => ({}),
	});
	const registry = createModelProviderRegistry({
		sets: [ownedProviderSet(definition, "scheduled-owner", "@test/scheduled")],
		piContributions: [],
		extensionConfig: { "scheduled-owner": {} },
		modelProfiles: config.pi.model_profiles,
		titleModelProfileId: null,
	});
	const modelStatusCache = createModelStatusCache({
		registry,
		modelProfiles: config.pi.model_profiles,
		credentialStatus: () => ({ available: true, revision: null }),
	});
	const processGraphs = createDefaultTestProcessGraphRegistry();
	const processActionRegistry = buildProcessActionRegistry({ processes: processGraphs });
	const supervisor = createFakeWorkerSupervisor();
	const processModelPolicy = createServerProcessModelPolicy({
		config,
		processGraphs,
		processActionRegistry,
	});
	const commands = createProcessEngine({
		...deps,
		config,
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => supervisor,
		processGraphs,
		getProcessActionRegistry: () => processActionRegistry,
		processModelPolicy,
		getModelAvailabilitySnapshot: () => modelStatusCache.snapshot(),
		prepareTurnStarts: (process, writes, providerOptions) =>
			prepareCreatedTurnStarts(
				{
					config,
					registry,
					modelStatusCache,
					piContributions: [],
					bundleCache: createPiResourceBundleCache(),
					projects: deps.projects,
					processSkills: deps.processSkills,
					skills: deps.skills,
				},
				process,
				writes,
				providerOptions,
			),
	});
	return { deps, commands, modelStatusCache, supervisor };
}

async function executeDueApproval(harness: ReturnType<typeof setup>) {
	await harness.modelStatusCache.refresh();
	const process = harness.deps.processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "plan_review",
		defaultModelProfileId: "scheduled-model",
		lifecycleStatus: "waiting",
		stateJson: JSON.stringify({}),
	});
	const scheduled = harness.deps.futureExecutions.create({
		kind: "action",
		scheduleKind: "once",
		processId: process.processId,
		instanceId: process.id,
		actionId: "plan_approved",
		payloadJson: "{}",
		nextRunAt: "2026-04-25T09:00:00.000Z",
	});
	const result = await harness.commands.executeProcessAction(
		process.id,
		"plan_approved",
		{},
		{
			source: "scheduled",
			scheduledExecutionId: scheduled.id,
			consumeScheduledExecutionOnSuccess: true,
		},
	);
	return { process, scheduled, result };
}

describe("scheduled action provider-option preparation", () => {
	it("resolves a provider default when the scheduled action executes, not when it is stored", async () => {
		let account = "when-scheduled";
		const harness = setup({ defaultAccount: () => account });
		account = "when-executed";
		const { process, result, scheduled } = await executeDueApproval(harness);

		expect(result.ok).toBe(true);
		expect(harness.deps.futureExecutions.getById(scheduled.id)).toBeNull();
		expect(harness.deps.turnStarts.listByInstance(process.id)).toEqual([
			expect.objectContaining({
				turnId: "implement",
				state: expect.objectContaining({
					kind: "starting",
					start: expect.objectContaining({ providerOptions: { account: "when-executed" } }),
				}),
			}),
		]);
	});

	it("parks a committed scheduled action without a worker attempt when required options are absent", async () => {
		const harness = setup();
		const { process, result, scheduled } = await executeDueApproval(harness);

		expect(result.ok).toBe(true);
		expect(harness.deps.futureExecutions.getById(scheduled.id)).toBeNull();
		expect(harness.deps.processes.getById(process.id)?.lifecycleStatus).toBe("error");
		expect(harness.deps.turnStarts.listByInstance(process.id)).toEqual([
			expect.objectContaining({
				turnId: "implement",
				state: expect.objectContaining({
					kind: "preparation_failed",
					code: "provider_options_required",
				}),
			}),
		]);
		expect(harness.deps.turnRecords.listByInstance(process.id)).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ turnType: "llm" })]),
		);
		expect(harness.supervisor.spawnCalls).toEqual([]);
	});
});

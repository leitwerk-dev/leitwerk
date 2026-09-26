import { ADMIN_ACTOR, type ProcessInstance, type TurnStartRecord } from "@leitwerk-dev/domain";
import { defineModelProvider } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { createModelStatusCache } from "./model-providers/model-status-cache.js";
import { createModelProviderRegistry } from "./model-providers/registry.js";
import { createPiResourceBundleCache } from "./pi-resources/index.js";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { createProcessEngine } from "./process-engine/engine.js";
import { prepareCreatedTurnStarts } from "./process-engine/turn-start-preflight.js";
import { createWrites } from "./process-engine/writes/writes.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createFakeWorkerSupervisor } from "./test-helpers/fake-worker-supervisor.js";
import { ownedProviderSet } from "./test-helpers/model-provider-fixtures.js";
import { createOwnedTestDeps } from "./test-helpers/owned-test-deps.js";
import { createTestTurnStart } from "./test-helpers/process-model-fixtures.js";
import {
	createSettingsFixture,
	model,
	repositoryInstructions,
} from "./test-helpers/scoped-settings-fixtures.js";

async function setup() {
	const store = createOwnedTestDeps();
	const fixture = await createSettingsFixture(store);
	const provider = defineModelProvider({
		id: "test",
		parseConfig: () => ({ config: {} }),
		worker: { kind: "builtin_pi_provider", provider: "test" },
		models: async () =>
			["one", "two"].map((modelId) => ({ modelId, availability: "available" as const })),
		secrets: () => ({}),
	});
	const registry = createModelProviderRegistry({
		sets: [ownedProviderSet(provider, "settings-test", "@test/settings")],
		piContributions: [],
		extensionConfig: { "settings-test": {} },
		modelProfiles: fixture.config.pi.model_profiles,
		titleModelProfileId: null,
	});
	const modelStatusCache = createModelStatusCache({
		registry,
		modelProfiles: fixture.config.pi.model_profiles,
		credentialStatus: () => ({ available: true, revision: null }),
	});
	await modelStatusCache.refresh();
	const deps = {
		config: fixture.config,
		registry,
		modelStatusCache,
		piContributions: [],
		bundleCache: createPiResourceBundleCache(),
		projects: fixture.repos.projects,
		processSkills: fixture.repos.processSkills,
		processModelPolicy: fixture.policy,
		scopedSettings: fixture.settings,
	};
	const write = (key: string, value: unknown) =>
		fixture.settings.write({
			subjectId: "instance",
			key,
			value,
			mode: "replace",
			reset: false,
			expectedRevision: fixture.repos.scopedSettings.getOverride("instance", key)?.revision ?? 0,
			actor: ADMIN_ACTOR,
		});
	function prepare(
		process: ProcessInstance,
		startKind: TurnStartRecord["startKind"] = "selected_turn",
	) {
		const writes = createWrites({
			turnStartWrites: [
				{
					kind: "create",
					input: createTestTurnStart({
						id: crypto.randomUUID(),
						instanceId: process.id,
						proposedTurnRecordId: crypto.randomUUID(),
						startKind,
					}),
				},
			],
		});
		return { writes, done: prepareCreatedTurnStarts(deps, process, writes) };
	}
	return { ...fixture, store, deps, write, prepare };
}

describe("scoped settings at the turn preparation boundary", () => {
	it("captures model and instructions together, retains recovery snapshots, and resolves edits for a new operator retry", async () => {
		const { repos, write, prepare, deps, policy } = await setup();
		const process = repos.processes.create({
			processId: "settings_process",
			selectedTurnId: "run",
		});
		write(model.key, "second");
		write(repositoryInstructions.key, "Before preparation");
		const first = prepare(process);
		// Resource assembly yields; edits during it belong only to a later start.
		write(model.key, "first");
		write(repositoryInstructions.key, "After preparation");
		expect(await first.done).toEqual({ ok: true });
		const firstWrite = first.writes.turnStartWrites[0];
		if (firstWrite.kind !== "create") throw new Error("Expected created start");
		const retained = repos.turnStarts.create(firstWrite.input);
		expect(retained.state).toMatchObject({
			kind: "starting",
			start: {
				model: { profileId: "second" },
				scopedSettings: {
					values: expect.arrayContaining([
						expect.objectContaining({ key: model.key, value: "second" }),
					]),
					instructions: [
						expect.objectContaining({
							setting: expect.objectContaining({ value: "Before preparation" }),
						}),
					],
				},
			},
		});
		const fingerprint = policy.fingerprint({ process, currentStart: retained });
		const recovery = createWrites({
			turnStartWrites: [
				{ kind: "cas_state", id: retained.id, expectedKind: "starting", state: retained.state },
			],
		});
		await prepareCreatedTurnStarts(deps, process, recovery);
		expect(recovery.turnStartWrites[0]).toMatchObject({ state: retained.state });
		expect(
			policy.fingerprint({ process, currentStart: repos.turnStarts.getById(retained.id) }),
		).toBe(fingerprint);
		const retry = prepare(process, "retry");
		expect(await retry.done).toEqual({ ok: true });
		expect(retry.writes.turnStartWrites[0]).toMatchObject({
			input: {
				state: {
					kind: "starting",
					start: {
						model: { profileId: "first" },
						scopedSettings: {
							instructions: [
								expect.objectContaining({
									setting: expect.objectContaining({ value: "After preparation" }),
								}),
							],
						},
					},
				},
			},
		});
	});

	it("parks invalid required instructions without sending a worker start", async () => {
		const { repos, prepare } = await setup();
		const process = repos.processes.create({
			processId: "settings_process",
			selectedTurnId: "run",
		});
		repos.scopedSettings.write({
			subjectId: "instance",
			key: repositoryInstructions.key,
			value: 123,
			mode: "replace",
			reset: false,
			expectedRevision: 0,
			schemaVersion: 1,
			actor: ADMIN_ACTOR,
		});
		const pending = prepare(process);
		expect(await pending.done).toEqual({ ok: true });
		expect(pending.writes.processPatch.lifecycleStatus).toBe("error");
		expect(pending.writes.workerIntent).toEqual({ kind: "reconcile" });
		expect(pending.writes.turnStartWrites[0]).toMatchObject({
			input: {
				state: {
					kind: "preparation_failed",
					code: "invalid_model_configuration",
					safeSummary: expect.stringContaining("Correct"),
				},
			},
		});
	});
	it("resolves scheduled actions at dispatch using the same model and instructions as the current preview", async () => {
		const { store, repos, catalog, config, policy, settings, deps, write } = await setup();
		const registry = buildProcessActionRegistry(catalog);
		const supervisor = createFakeWorkerSupervisor();
		const commands = createProcessEngine({
			...store,
			config,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs: catalog.processes,
			getProcessActionRegistry: () => registry,
			processModelPolicy: policy,
			getModelAvailabilitySnapshot: () => deps.modelStatusCache.snapshot(),
			prepareTurnStarts: (process, writes, options) =>
				prepareCreatedTurnStarts(deps, process, writes, options),
		});
		const process = repos.processes.create({
			processId: "settings_process",
			selectedTurnId: "review",
			lifecycleStatus: "waiting",
			stateJson: "{}",
			paramsJson: "{}",
		});
		write(model.key, "first");
		write(repositoryInstructions.key, "When scheduled");
		const scheduled = repos.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "proceed",
			payloadJson: "{}",
			nextRunAt: "2026-09-26T06:00:00Z",
		});
		write(model.key, "second");
		write(repositoryInstructions.key, "When dispatched");
		const preview = policy.evaluate({
			kind: "process_turn",
			process,
			turnId: "run",
			availability: deps.modelStatusCache.snapshot(),
		});
		expect(preview).toMatchObject({ ok: true, selection: { modelProfileId: "second" } });
		const expectedSettings = settings.capture(process, "run");
		expect(
			(
				await commands.executeProcessAction(
					process.id,
					"proceed",
					{},
					{
						source: "scheduled",
						scheduledExecutionId: scheduled.id,
						consumeScheduledExecutionOnSuccess: true,
					},
				)
			).ok,
		).toBe(true);
		expect(repos.futureExecutions.getById(scheduled.id)).toBeNull();
		expect(repos.turnStarts.listByInstance(process.id)).toEqual([
			expect.objectContaining({
				state: {
					kind: "starting",
					start: expect.objectContaining({
						model: expect.objectContaining({ profileId: "second" }),
						scopedSettings: expectedSettings,
					}),
				},
			}),
		]);
	});

	it("allows explicit models to supersede an incompatible unused scoped model default", async () => {
		const { repos, prepare } = await setup();
		const process = repos.processes.create({
			processId: "settings_process",
			selectedTurnId: "run",
			defaultModelProfileId: "first",
		});
		repos.scopedSettings.write({
			subjectId: "instance",
			key: model.key,
			value: "removed-profile",
			mode: "replace",
			reset: false,
			expectedRevision: 0,
			schemaVersion: 1,
			actor: ADMIN_ACTOR,
		});
		const pending = prepare(process);
		expect(await pending.done).toEqual({ ok: true });
		expect(pending.writes.turnStartWrites[0]).toMatchObject({
			input: { state: { kind: "starting", start: { model: { profileId: "first" } } } },
		});
	});
});

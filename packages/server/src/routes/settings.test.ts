import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { serializeFutureLaunchPayload } from "@leitwerk-dev/protocol";
import Fastify from "fastify";
import { describe, expect, it, onTestFinished } from "vitest";
import { reconcileFutureExecutionModelBlocks } from "../future-execution/reconciliation.js";
import { buildProcessActionRegistry } from "../process-action-registry.js";
import { createProcessOperationCoordinator } from "../process-operation-coordinator.js";
import {
	createModelAvailabilitySnapshot,
	createTestLaunchPlan,
} from "../test-helpers/process-model-fixtures.js";
import {
	createSettingsFixture,
	model,
	repositoryInstructions,
} from "../test-helpers/scoped-settings-fixtures.js";
import { createBroadcaster } from "../ws/broadcast.js";
import { registerSettingsRoutes } from "./settings.js";

async function setup() {
	const fixture = await createSettingsFixture();
	const app = Fastify();
	onTestFinished(() => app.close());
	const processOperations = createProcessOperationCoordinator();
	const broadcaster = createBroadcaster();
	let availability = createModelAvailabilitySnapshot();
	const reconcile = async () => {
		await reconcileFutureExecutionModelBlocks({
			...fixture.repos,
			processOperations,
			broadcaster,
			processGraphs: fixture.catalog.processes,
			processActionRegistry: buildProcessActionRegistry(fixture.catalog),
			policy: fixture.policy,
			availability,
			getModelAvailabilitySnapshot: () => availability,
			asOf: new Date().toISOString(),
		});
	};
	registerSettingsRoutes(app, fixture.settings, {
		...fixture.repos,
		processOperations,
		broadcaster,
		onSettingsChanged: reconcile,
	});
	return {
		...fixture,
		app,
		reconcile,
		setAvailability(value: typeof availability) {
			availability = value;
		},
	};
}

describe("settings HTTP contract", () => {
	it("uses identical preview/save validation, defaults instructions to append, and checks revisions on reset", async () => {
		const { app, repos } = await setup();
		const payload = {
			subjectId: "instance",
			key: repositoryInstructions.key,
			value: "Installation rules",
			expectedRevision: 0,
		};
		const preview = await app.inject({ method: "POST", url: "/api/settings/preview", payload });
		expect(preview.statusCode).toBe(200);
		expect(repos.scopedSettings.getOverride("instance", payload.key)).toBeNull();
		const saved = await app.inject({ method: "PUT", url: "/api/settings/overrides", payload });
		expect(saved.statusCode).toBe(200);
		const field = (response: typeof saved) =>
			response.json().fields.find((f: { key: string }) => f.key === payload.key);
		expect(field(saved).effective.value).toEqual(field(preview).effective.value);
		expect(field(saved).effective.value).toBe("Code instructions\n\nInstallation rules");
		expect(field(saved).override).toMatchObject({
			mode: "append",
			revision: 1,
			actor: ADMIN_ACTOR,
		});
		expect(
			(await app.inject({ method: "PUT", url: "/api/settings/overrides", payload })).statusCode,
		).toBe(409);
		const reset = await app.inject({
			method: "PUT",
			url: "/api/settings/overrides",
			payload: { ...payload, value: undefined, reset: true, expectedRevision: 1 },
		});
		expect(reset.statusCode).toBe(200);
		expect(field(reset).effective.value).toBe("Code instructions");
		expect(field(reset).override).toMatchObject({ reset: true, revision: 2 });
		expect(
			(await app.inject({ method: "PUT", url: "/api/settings/overrides", payload })).statusCode,
		).toBe(409);
		for (const method of ["POST", "PUT"] as const) {
			const invalid = await app.inject({
				method,
				url: `/api/settings/${method === "POST" ? "preview" : "overrides"}`,
				payload: { ...payload, key: model.key, value: "removed-model" },
			});
			expect(invalid.statusCode).toBe(422);
			expect(invalid.json().message).toContain("Unknown model profile");
		}
	});

	it("binds only retained repositories and rejects a stale primary-repository edit", async () => {
		const { app, repos } = await setup();
		const process = repos.processes.create({
			processId: "settings_process",
			selectedTurnId: "run",
		});
		for (const key of ["public", "private"])
			repos.projects.create({
				instanceId: process.id,
				key,
				repoLocator: `/workspace/${key}`,
				baseBranch: "main",
			});
		const url = `/api/settings/processes/${process.id}/primary-repository`;
		const update = (key: string) =>
			app.inject({
				method: "PUT",
				url,
				payload: { primaryRepositoryKey: key, expectedPrimaryRepositoryKey: null },
			});
		expect((await update("unknown")).statusCode).toBe(422);
		expect((await update("private")).statusCode).toBe(200);
		expect((await update("public")).statusCode).toBe(409);
		const preview = await app.inject({
			method: "GET",
			url: `/api/settings/processes/${process.id}`,
		});
		expect(preview.statusCode).toBe(200);
		expect(preview.json().context.repository).toBe(
			preview.json().repositories.find((r: { key: string }) => r.key === "private").subjectId,
		);
		expect(repos.events.listByInstance(process.id, 10)[0]?.data.actor).toEqual(ADMIN_ACTOR);
	});
	it("refreshes inherited scheduled launches and actions, clears obsolete blocks, and preserves explicit models", async () => {
		const { app, repos, reconcile, setAvailability } = await setup();
		setAvailability(
			createModelAvailabilitySnapshot([
				{ profileId: "first", modelId: "one", availability: "unavailable" },
				{ profileId: "second", modelId: "two" },
			]),
		);
		const launches = [false, true].map((explicit) =>
			repos.futureExecutions.create({
				kind: "launch",
				scheduleKind: "once",
				processId: "settings_process",
				launcherId: "settings-test.launcher",
				payloadJson: serializeFutureLaunchPayload({
					launcherInput: {},
					modelConfig: explicit ? { defaultModelProfileId: "first" } : {},
					launchPlan: createTestLaunchPlan({
						processId: "settings_process",
						launcherId: "settings-test.launcher",
						processInput: {
							processId: "settings_process",
							...(explicit ? { defaultModelProfileId: "first" } : {}),
						},
					}),
				}),
				nextRunAt: "2027-01-01T00:00:00.000Z",
			}),
		);
		const process = repos.processes.create({
			processId: "settings_process",
			selectedTurnId: "review",
			lifecycleStatus: "waiting",
			paramsJson: "{}",
			stateJson: "{}",
		});
		const action = repos.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "proceed",
			payloadJson: "{}",
			nextRunAt: "2027-01-01T00:00:00.000Z",
		});
		await reconcile();
		for (const scheduled of [...launches, action])
			expect(repos.futureExecutions.getById(scheduled.id)).toMatchObject({
				modelSelection: { modelProfileId: "first" },
				blockedReason: { code: "model_unavailable" },
			});
		const saved = await app.inject({
			method: "PUT",
			url: "/api/settings/overrides",
			payload: { subjectId: "instance", key: model.key, value: "second", expectedRevision: 0 },
		});
		expect(saved.statusCode).toBe(200);
		for (const scheduled of [launches[0], action])
			expect(repos.futureExecutions.getById(scheduled.id)).toMatchObject({
				modelSelection: {
					modelProfileId: "second",
					provenance: { source: "scoped_purpose_default" },
				},
				blockedReason: null,
			});
		expect(repos.futureExecutions.getById(launches[1].id)).toMatchObject({
			modelSelection: { modelProfileId: "first" },
			blockedReason: { code: "model_unavailable" },
		});
		const reset = await app.inject({
			method: "PUT",
			url: "/api/settings/overrides",
			payload: { subjectId: "instance", key: model.key, reset: true, expectedRevision: 1 },
		});
		expect(reset.statusCode).toBe(200);
		expect(repos.futureExecutions.getById(launches[0].id)).toMatchObject({
			modelSelection: { modelProfileId: "first" },
			blockedReason: { code: "model_unavailable" },
		});
	});
});

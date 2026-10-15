import { SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { serializeFutureActionPayload, serializeFutureLaunchPayload } from "@leitwerk-dev/protocol";
import { describe, expect, it, vi } from "vitest";
import {
	buildDashboardModelIssues,
	type DashboardModelIssueDeps,
} from "./dashboard-model-issues.js";
import {
	createModelAvailabilitySnapshot,
	createTestLaunchPlan,
} from "./test-helpers/process-model-fixtures.js";
import { createSettingsFixture, model } from "./test-helpers/scoped-settings-fixtures.js";

async function setup() {
	const fixture = await createSettingsFixture();
	const cache = {
		snapshot: vi.fn(() => createModelAvailabilitySnapshot()),
		refresh: vi.fn(async () => createModelAvailabilitySnapshot()),
		get: vi.fn(() => null),
	};
	const deps: DashboardModelIssueDeps = {
		...fixture.repos,
		config: fixture.config,
		processGraphs: fixture.catalog.processes,
		processModelPolicy: fixture.policy,
		scopedSettingsService: fixture.settings,
		modelStatusCache: cache,
	};
	return { ...fixture, deps, cache };
}

function override(
	fixture: Awaited<ReturnType<typeof setup>>,
	subjectId: string,
	value: unknown,
	schemaVersion = 1,
	key = model.key,
) {
	fixture.repos.scopedSettings.putSubject({
		id: subjectId,
		scopeType: "repository",
		identity: subjectId,
		label: subjectId,
		context: {},
	});
	fixture.repos.scopedSettings.write({
		subjectId,
		key,
		value,
		schemaVersion,
		mode: "replace",
		reset: false,
		actor: SYSTEM_ACTOR,
		expectedRevision: 0,
	});
}

describe("dashboard model diagnostics", () => {
	it("deduplicates unavailable credentials and keeps cached stale status a warning without provider queries", async () => {
		const f = await setup();
		f.cache.snapshot.mockReturnValue(
			createModelAvailabilitySnapshot([
				{ profileId: "first", availability: "unavailable" },
				{ profileId: "second", availability: "stale" },
			]),
		);
		f.repos.processes.create({ processId: "settings_process", defaultModelProfileId: "first" });
		const refresh = vi.spyOn(f.settings, "refresh");
		const discover = vi.spyOn(f.settings, "forProcess");
		const choices = vi.spyOn(f.settings, "preview");
		const before = f.repos.scopedSettings.listSubjects();
		const issues = buildDashboardModelIssues(f.deps);
		expect(issues.filter((issue) => issue.code === "model_unavailable")).toHaveLength(1);
		expect(
			issues.find((issue) => issue.code === "model_unavailable")?.sources.length,
		).toBeGreaterThan(2);
		expect(issues.find((issue) => issue.code === "model_stale")?.severity).toBe("warning");
		expect(f.cache.snapshot).toHaveBeenCalledOnce();
		expect(f.cache.refresh).not.toHaveBeenCalled();
		expect(f.cache.get).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(discover).not.toHaveBeenCalled();
		expect(choices).not.toHaveBeenCalled();
		expect(f.repos.scopedSettings.listSubjects()).toEqual(before);
	});

	it("reports missing configuration refs, isolated invalid settings, and removed model profiles", async () => {
		const f = await setup();
		f.config.pi.default_model_profile = "removed-global";
		f.config.pi.process_title_generation.model_profile = "removed-title";
		override(f, "invalid", { model: "bad" });
		override(f, "removed", "removed-setting");
		override(f, "old-schema", "first", 99);
		override(f, "inactive", "removed-inactive", 1, "removed-extension.model");
		const refs = f.settings.modelReferences();
		expect(refs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ subjectId: "invalid", invalid: true }),
				expect.objectContaining({
					subjectId: "removed",
					modelProfileId: "removed-setting",
					invalid: false,
				}),
				expect.objectContaining({ subjectId: "old-schema", invalid: true }),
			]),
		);
		expect(refs.some((ref) => ref.subjectId === "inactive")).toBe(false);
		const issues = buildDashboardModelIssues(f.deps);
		expect(issues.filter((issue) => issue.code === "invalid_model_configuration")).toHaveLength(2);
		for (const name of ["removed-global", "removed-title", "removed-setting"])
			expect(
				issues.some(
					(issue) => issue.code === "unknown_model_profile" && issue.message.includes(name),
				),
			).toBe(true);
		expect(
			issues.find((issue) => issue.message.includes("removed-setting"))?.sources[0]?.href,
		).toBe("/settings?scope=removed");
	});

	it("reads every current reference beyond the first page and excludes completed and aborted archives", async () => {
		const f = await setup();
		for (let i = 0; i < 125; i++)
			f.repos.processes.create({
				processId: "settings_process",
				defaultModelProfileId: "removed-current",
				title: `current-${i}`,
			});
		for (const lifecycleStatus of ["completed", "aborted"] as const)
			f.repos.processes.create({
				processId: "settings_process",
				defaultModelProfileId: `removed-${lifecycleStatus}`,
				lifecycleStatus,
			});
		const issues = buildDashboardModelIssues(f.deps);
		const issue = issues.find((item) => item.message.includes("removed-current"));
		expect(issue?.sources).toHaveLength(125);
		expect(issues.some((item) => /removed-(completed|aborted)/.test(item.message))).toBe(false);
	});

	it("includes persisted scheduled action and launch references and malformed payloads", async () => {
		const f = await setup();
		const process = f.repos.processes.create({ processId: "settings_process" });
		const common = {
			scheduleKind: "once" as const,
			processId: "settings_process",
			nextRunAt: "2026-12-01T00:00:00.000Z",
		};
		const action = f.repos.futureExecutions.create({
			...common,
			kind: "action",
			instanceId: process.id,
			actionId: "proceed",
			payloadJson: serializeFutureActionPayload({
				input: {},
				actionLabel: "Proceed",
				nextTurnModelProfileId: "removed-action",
			}),
		});
		const launch = f.repos.futureExecutions.create({
			...common,
			kind: "launch",
			launcherId: "settings.launcher",
			payloadJson: serializeFutureLaunchPayload({
				launcherInput: {},
				modelConfig: {},
				launchPlan: createTestLaunchPlan({
					processId: "settings_process",
					processInput: { processId: "settings_process", defaultModelProfileId: "removed-launch" },
				}),
			}),
		});
		const invalid = f.repos.futureExecutions.create({
			...common,
			kind: "launch",
			launcherId: "settings.launcher",
			payloadJson: "{}",
		});
		const issues = buildDashboardModelIssues(f.deps);
		expect(issues.find((issue) => issue.message.includes("removed-action"))?.sources[0]?.href).toBe(
			`/processes/${process.id}`,
		);
		expect(issues.find((issue) => issue.message.includes("removed-launch"))?.sources[0]?.href).toBe(
			`/future-launches/${launch.id}`,
		);
		expect(
			issues.some(
				(issue) =>
					issue.code === "invalid_model_configuration" &&
					issue.sources[0]?.href === `/future-launches/${invalid.id}`,
			),
		).toBe(true);
		expect(
			issues.some((issue) => issue.sources.some((source) => source.label.includes(action.id))),
		).toBe(true);
	});
});

import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import {
	createScopedSettingsService,
	normalizeSettingsLocator,
} from "./scoped-settings-service.js";
import {
	createModelAvailabilitySnapshot,
	createTestTurnStart,
} from "./test-helpers/process-model-fixtures.js";
import {
	createSettingsFixture,
	instructions,
	model,
	repositoryInstructions,
	settingsExtension,
} from "./test-helpers/scoped-settings-fixtures.js";

describe("scoped settings", () => {
	it("resolves named compound scopes in declaration order, supports empty replacement and reset revisions", async () => {
		const { settings } = await createSettingsFixture();
		const issueType = settings.discover({
			scopeType: "settings-test.issue-type",
			identity: "bug",
			label: "Bug",
		});
		const project = settings.discover({
			scopeType: "settings-test.project",
			identity: "project-17",
			label: "Project",
		});
		const compound = settings.discover({
			scopeType: "settings-test.project-issue-type",
			identity: "project-17:bug",
			label: "Project Bugs",
			context: { [project.scopeType]: project.id, [issueType.scopeType]: issueType.id },
		});
		for (const [subjectId, value] of [
			["instance", "Instance"],
			[issueType.id, "Bug"],
			[project.id, "Project"],
			[compound.id, "Extra"],
		])
			settings.write({
				subjectId,
				key: instructions.key,
				value,
				mode: "append",
				reset: false,
				expectedRevision: 0,
				actor: ADMIN_ACTOR,
			});
		const context = { ...compound.context, [compound.scopeType]: compound.id };
		expect(settings.resolve(instructions, context).value).toBe(
			"Code instructions\n\nInstance\n\nBug\n\nProject\n\nExtra",
		);
		settings.write({
			subjectId: compound.id,
			key: instructions.key,
			value: "",
			mode: "replace",
			reset: false,
			expectedRevision: 1,
			actor: ADMIN_ACTOR,
		});
		expect(settings.resolve(instructions, context)).toMatchObject({
			value: "",
			sources: [{ subjectId: compound.id, revision: 2 }],
		});
		settings.write({
			subjectId: compound.id,
			key: instructions.key,
			value: null,
			mode: "replace",
			reset: true,
			expectedRevision: 2,
			actor: ADMIN_ACTOR,
		});
		expect(settings.resolve(instructions, context).value).toBe(
			"Code instructions\n\nInstance\n\nBug\n\nProject",
		);
		expect(() =>
			settings.write({
				subjectId: compound.id,
				key: instructions.key,
				value: "Lost edit",
				mode: "append",
				reset: false,
				expectedRevision: 0,
				actor: ADMIN_ACTOR,
			}),
		).toThrow("changed since");
		expect((await settings.preview(compound.id)).fields[0]?.override?.revision).toBe(3);
	});
	it("keeps aliases and overrides when provider discovery promotes a local identity or a repository is renamed", async () => {
		const { settings, repos } = await createSettingsFixture();
		const repo = settings.discover({
			scopeType: "repository",
			identity: "locator:ssh://git@example.org/team/repo.git",
			label: "old",
			aliases: ["ssh://git@example.org/team/repo.git"],
		});
		settings.write({
			subjectId: repo.id,
			key: model.key,
			value: "second",
			mode: "replace",
			reset: false,
			expectedRevision: 0,
			actor: ADMIN_ACTOR,
		});
		const found = settings.discover({
			scopeType: "repository",
			identity: 'provider:["https://example.org","42"]',
			label: "new",
			aliases: ["ssh://git@example.org/team/repo.git", "https://example.org/team/new.git"],
		});
		expect(found.id).toBe(repo.id);
		expect(settings.resolve(model, { repository: found.id }).value).toBe("second");
		expect(repos.scopedSettings.findAlias("https://example.org/team/new.git")?.id).toBe(repo.id);
		expect(() =>
			settings.discover({
				scopeType: "repository",
				identity: "provider:other",
				label: "other",
				aliases: ["https://example.org/team/new.git"],
			}),
		).toThrow("another provider identity");
		expect(normalizeSettingsLocator("/repo/../repo/code")).toBe("/repo/code");
		expect(normalizeSettingsLocator("git@example.org:team/repo.git")).not.toBe(
			normalizeSettingsLocator("https://example.org/team/repo.git"),
		);
	});
	it("retains inactive overrides across extension removal and rejects incompatible reinstalled values", async () => {
		const fixture = await createSettingsFixture();
		fixture.settings.write({
			subjectId: "instance",
			key: instructions.key,
			value: "Retained",
			mode: "replace",
			reset: false,
			expectedRevision: 0,
			actor: ADMIN_ACTOR,
		});
		const removed = await createSettingsFixture(fixture.repos, []);
		expect((await removed.settings.preview("instance")).inactive).toHaveLength(1);
		const reinstalled = await createSettingsFixture(fixture.repos);
		expect(reinstalled.settings.resolve(instructions, {}).value).toBe("Retained");
		const changed = await createSettingsFixture(fixture.repos, [
			{
				...settingsExtension,
				scopedSettings: {
					...settingsExtension.scopedSettings!,
					settings: [{ ...instructions, schemaVersion: 2 }, repositoryInstructions, model],
				},
			},
		]);
		expect(
			(await changed.settings.preview("instance")).fields.find(
				(field) => field.key === instructions.key,
			)?.error,
		).toContain("incompatible schema");
		expect(() => changed.settings.resolve(instructions, {})).toThrow("Correct");
	});
	it("uses primary repository defaults, labels each repository's instructions, and keeps captured starts unchanged", async () => {
		const { settings, repos, policy } = await createSettingsFixture();
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
		const subjects = settings.forProcess(process).subjects;
		for (const { project, subject } of subjects)
			settings.write({
				subjectId: subject.id,
				key: repositoryInstructions.key,
				value: `Rules for ${project.key}`,
				mode: "replace",
				reset: false,
				expectedRevision: 0,
				actor: ADMIN_ACTOR,
			});
		settings.write({
			subjectId: "instance",
			key: model.key,
			value: "first",
			mode: "replace",
			reset: false,
			expectedRevision: 0,
			actor: ADMIN_ACTOR,
		});
		settings.write({
			subjectId: subjects[1].subject.id,
			key: model.key,
			value: "second",
			mode: "replace",
			reset: false,
			expectedRevision: 0,
			actor: ADMIN_ACTOR,
		});
		expect(settings.capture(process, "run")?.explanations[0]).toContain("No primary repository");
		expect(settings.modelDefault(process.processId, "run", process)).toBe("first");
		const bound = repos.processes.update(process.id, {
			metadata: { primaryRepositoryKey: "private" },
		})!;
		expect(settings.modelDefault(process.processId, "run", bound)).toBe("second");
		const captured = settings.capture(bound, "run")!;
		expect(
			captured.instructions.map((block) => [block.label.split(" — ")[0], block.setting.value]),
		).toEqual([
			["public", "Rules for public"],
			["private", "Rules for private"],
		]);
		const template = createTestTurnStart({ instanceId: process.id });
		if (template.state.kind !== "starting" || template.state.start.kind !== "llm")
			throw new Error("Expected LLM start fixture");
		const start = repos.turnStarts.create({
			...template,
			id: undefined,
			state: { kind: "starting", start: { ...template.state.start, scopedSettings: captured } },
		});
		const fingerprint = policy.fingerprint({ process: bound, currentStart: start });
		settings.write({
			subjectId: subjects[1].subject.id,
			key: repositoryInstructions.key,
			value: "Changed",
			mode: "replace",
			reset: false,
			expectedRevision: 1,
			actor: ADMIN_ACTOR,
		});
		expect(settings.capture(bound, "run")?.instructions[1].setting.value).toBe("Changed");
		expect(repos.turnStarts.getById(start.id)).toEqual(start);
		expect(policy.fingerprint({ process: bound, currentStart: start })).toBe(fingerprint);
	});
	it("uses the same scoped model for launch, action and retry previews, with explicit choices taking precedence", async () => {
		const { settings, repos, policy } = await createSettingsFixture();
		const process = repos.processes.create({
			processId: "settings_process",
			selectedTurnId: "run",
		});
		repos.projects.create({
			instanceId: process.id,
			key: "repo",
			repoLocator: "/workspace/repo",
			baseBranch: "main",
		});
		const subjectId = settings.forProcess(process).context.repository;
		settings.write({
			subjectId,
			key: model.key,
			value: "second",
			mode: "replace",
			reset: false,
			expectedRevision: 0,
			actor: ADMIN_ACTOR,
		});
		const availability = createModelAvailabilitySnapshot();
		const request = { kind: "process_turn" as const, process, turnId: "run", availability };
		expect(policy.evaluate(request)).toMatchObject({
			ok: true,
			selection: {
				modelProfileId: "second",
				provenance: { kind: "inherited", source: "scoped_purpose_default" },
			},
		});
		const plan = {
			launcherId: "test",
			processId: process.processId,
			processInput: process,
			projectInputs: repos.projects.listByInstance(process.id),
			startTurnId: "run",
		};
		expect(
			policy.project({
				kind: "launcher_preview",
				processId: process.processId,
				modelConfig: {},
				plan,
				availability,
			}).turns[0].effective.profile?.id,
		).toBe("second");
		expect(
			policy.evaluate({ kind: "launch_plan_turn", plan, turnId: "run", availability }),
		).toMatchObject({ ok: true, selection: { modelProfileId: "second" } });
		expect(
			policy.evaluate({ ...request, process: { ...process, defaultModelProfileId: "second" } }),
		).toMatchObject({
			selection: { modelProfileId: "second", provenance: { source: "instance_default" } },
		});
		expect(
			policy.evaluate({
				...request,
				process: { ...process, turnConfigsJson: '{"run":{"modelProfileId":"first"}}' },
			}),
		).toMatchObject({
			selection: { modelProfileId: "first", provenance: { source: "instance_turn_config" } },
		});
		expect(policy.evaluate({ ...request, modelOverride: "first" })).toMatchObject({
			selection: { modelProfileId: "first", provenance: { source: "action_override" } },
		});
		expect(
			policy.evaluate({
				...request,
				startKind: "retry",
				modelOverride: null,
				process: {
					...process,
					selectedTurnModelProfileId: "first",
					selectedTurnModelKind: "explicit",
					selectedTurnModelSource: "action_override",
				},
			}),
		).toMatchObject({
			selection: { modelProfileId: "second", provenance: { source: "scoped_purpose_default" } },
		});
		expect(
			policy.evaluate({
				...request,
				availability: createModelAvailabilitySnapshot([
					{ profileId: "first" },
					{ profileId: "second", availability: "unavailable" },
				]),
			}),
		).toMatchObject({
			ok: false,
			code: "model_unavailable",
			selection: { modelProfileId: "second" },
		});
	});
	it("shows an unavailable inherited model with its correction instructions", async () => {
		const fixture = await createSettingsFixture();
		fixture.settings.write({
			subjectId: "instance",
			key: model.key,
			value: "second",
			mode: "replace",
			reset: false,
			expectedRevision: 0,
			actor: ADMIN_ACTOR,
		});
		const settings = createScopedSettingsService({
			...fixture,
			modelChoices: () => [
				{
					value: "second",
					label: "Second model",
					disabledReason: "Provider credential is missing",
				},
			],
		});
		const field = (await settings.preview("instance")).fields.find(
			(field) => field.key === model.key,
		);
		expect(field?.effective?.value).toBe("second");
		expect(field?.error).toContain("Provider credential is missing");
		expect(field?.error).toContain("choose another model");
	});
});

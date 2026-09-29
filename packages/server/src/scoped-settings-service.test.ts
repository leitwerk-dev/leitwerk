import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import {
	createScopedSettingsService,
	normalizeSettingsLocator,
	type ScopedSettingsService,
} from "./scoped-settings-service.js";
import {
	createModelAvailabilitySnapshot,
	createTestTurnStart,
} from "./test-helpers/process-model-fixtures.js";
import {
	createSettingsFixture,
	createSettingsProcess,
	instructions,
	model,
	repositoryInstructions,
	settingsExtension,
} from "./test-helpers/scoped-settings-fixtures.js";

function write(
	settings: ScopedSettingsService,
	change: Pick<Parameters<ScopedSettingsService["write"]>[0], "subjectId" | "key" | "value"> &
		Partial<Parameters<ScopedSettingsService["write"]>[0]>,
) {
	return settings.write({
		mode: "replace",
		reset: false,
		expectedRevision: 0,
		actor: ADMIN_ACTOR,
		...change,
	});
}

const aliases = ["git@example.org:team/repo.git", "https://example.org/team/repo.git"];
function locatorSubjects(settings: ScopedSettingsService) {
	return aliases.map((alias) =>
		settings.discover({
			scopeType: "repository",
			identity: `locator:${alias}`,
			label: alias,
			aliases: [alias],
		}),
	);
}

describe("scoped settings", () => {
	it.each([
		false,
		true,
	])("coalesces verified clone aliases and retains old scope IDs (known provider: %s)", async (knownProvider) => {
		const { settings, repos } = await createSettingsFixture();
		const identity = 'provider:["https://example.org","42"]';
		const provider = knownProvider
			? settings.discover({ scopeType: "repository", identity, label: "team/repo" })
			: null;
		const subjects = locatorSubjects(settings);
		const change = {
			key: repositoryInstructions.key,
			value: "Repository guidance",
			mode: "append" as const,
		};
		for (const subject of subjects) write(settings, { ...change, subjectId: subject.id });
		write(settings, {
			...change,
			subjectId: subjects[1].id,
			key: model.key,
			mode: "replace",
			value: "second",
		});
		const merged = settings.discover({
			scopeType: "repository",
			identity,
			label: "team/repo",
			aliases,
		});
		if (provider) expect(merged.id).toBe(provider.id);
		expect(
			settings.listScopes().subjects.filter((subject) => subject.scopeType === "repository"),
		).toHaveLength(1);
		for (const original of subjects) {
			expect(repos.scopedSettings.getSubject(original.id)?.id).toBe(merged.id);
			expect(settings.resolve(model, { repository: original.id }).value).toBe("second");
			expect(settings.resolve(repositoryInstructions, { repository: original.id }).value).toBe(
				"Code instructions\n\nRepository guidance",
			);
			expect(() =>
				write(settings, { ...change, subjectId: original.id, expectedRevision: 1 }),
			).toThrow("changed since");
			const preview = await settings.preview(original.id);
			expect(preview.subject.id).toBe(merged.id);
			expect(
				preview.fields.find((field) => field.key === repositoryInstructions.key)?.override?.actor,
			).toEqual(ADMIN_ACTOR);
		}
		const row = repos.scopedSettings.getOverride(merged.id, repositoryInstructions.key);
		if (!row) throw new Error("Missing merged override");
		const preview = await settings.previewDraft({
			...change,
			subjectId: subjects[1].id,
			value: "Updated guidance",
			reset: false,
			actor: ADMIN_ACTOR,
		});
		expect(
			preview.fields.find((field) => field.key === repositoryInstructions.key)?.effective?.value,
		).toContain("Updated guidance");
		write(settings, {
			...change,
			subjectId: subjects[1].id,
			value: "Updated guidance",
			expectedRevision: row.revision,
		});
		expect(
			settings.resolve(repositoryInstructions, { repository: subjects[0].id }).value,
		).toContain("Updated guidance");
		const beforeRediscovery = repos.scopedSettings.listOverrides();
		settings.discover({
			scopeType: "repository",
			identity,
			label: "renamed",
			aliases: [...aliases].reverse(),
		});
		expect(repos.scopedSettings.listOverrides()).toEqual(beforeRediscovery);
	});
	it.each([
		"value",
		"mode",
		"schema",
	])("keeps conflicting %s overrides intact until the operator resolves them", async (conflict) => {
		const { settings, repos, config, catalog } = await createSettingsFixture();
		const subjects = locatorSubjects(settings);
		for (const [index, subject] of subjects.entries())
			repos.scopedSettings.write({
				subjectId: subject.id,
				key: repositoryInstructions.key,
				value: conflict === "value" ? String(index) : "same",
				mode: conflict === "mode" && index === 1 ? "replace" : "append",
				reset: false,
				schemaVersion: conflict === "schema" ? index + 1 : 1,
				expectedRevision: 0,
				actor: ADMIN_ACTOR,
			});
		const input = {
			scopeType: "repository",
			identity: 'provider:["https://example.org","42"]',
			label: "team/repo",
			aliases,
		};
		const before = repos.scopedSettings.listOverrides();
		expect(() => settings.discover(input)).toThrow(`Compare /settings?scope=${subjects[0].id}`);
		expect(repos.scopedSettings.listOverrides()).toEqual(before);
		expect(repos.scopedSettings.findAlias(aliases[0])?.id).toBe(subjects[0].id);
		const process = repos.processes.create({
			processId: "settings_process",
			selectedTurnId: "run",
		});
		repos.projects.create({
			instanceId: process.id,
			key: "repo",
			repoLocator: aliases[0],
			baseBranch: "main",
			metadata: {
				settingsRepository: { origin: "https://example.org", repositoryId: 42, aliases },
			},
		});
		const restarted = createScopedSettingsService({ repos, config, catalog });
		expect(
			restarted.listScopes().subjects.filter((subject) => subject.scopeType === "repository"),
		).toHaveLength(2);
		expect(() => restarted.capture(process, "run")).toThrow("conflicting overrides");
		write(settings, {
			subjectId: subjects[1].id,
			key: repositoryInstructions.key,
			value: null,
			reset: true,
			expectedRevision: 1,
		});
		expect(() => settings.discover(input)).not.toThrow();
		expect(restarted.capture(process, "run")?.instructions[0].setting.value).toBe(
			`Code instructions\n\n${conflict === "value" ? "0" : "same"}`,
		);
	});
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
			write(settings, {
				subjectId,
				key: instructions.key,
				value,
				mode: "append",
			});
		const context = { ...compound.context, [compound.scopeType]: compound.id };
		expect(settings.resolve(instructions, context).value).toBe(
			"Code instructions\n\nInstance\n\nBug\n\nProject\n\nExtra",
		);
		write(settings, {
			subjectId: compound.id,
			key: instructions.key,
			value: "",
			expectedRevision: 1,
		});
		expect(settings.resolve(instructions, context)).toMatchObject({
			value: "",
			sources: [{ subjectId: compound.id, revision: 2 }],
		});
		write(settings, {
			subjectId: compound.id,
			key: instructions.key,
			value: null,
			reset: true,
			expectedRevision: 2,
		});
		expect(settings.resolve(instructions, context).value).toBe(
			"Code instructions\n\nInstance\n\nBug\n\nProject",
		);
		expect(() =>
			write(settings, {
				subjectId: compound.id,
				key: instructions.key,
				value: "Lost edit",
				mode: "append",
				expectedRevision: 0,
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
		write(settings, { subjectId: repo.id, key: model.key, value: "second" });
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
		write(fixture.settings, { subjectId: "instance", key: instructions.key, value: "Retained" });
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
		const process = createSettingsProcess(repos, ["public", "private"]);
		const subjects = settings.forProcess(process).subjects;
		for (const { project, subject } of subjects)
			write(settings, {
				subjectId: subject.id,
				key: repositoryInstructions.key,
				value: `Rules for ${project.key}`,
			});
		write(settings, { subjectId: "instance", key: model.key, value: "first" });
		write(settings, { subjectId: subjects[1].subject.id, key: model.key, value: "second" });
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
		write(settings, {
			subjectId: subjects[1].subject.id,
			key: repositoryInstructions.key,
			value: "Changed",
			expectedRevision: 1,
		});
		expect(settings.capture(bound, "run")?.instructions[1].setting.value).toBe("Changed");
		expect(repos.turnStarts.getById(start.id)).toEqual(start);
		expect(policy.fingerprint({ process: bound, currentStart: start })).toBe(fingerprint);
	});
	it("uses the same scoped model for launch, action and retry previews, with explicit choices taking precedence", async () => {
		const { settings, repos, policy } = await createSettingsFixture();
		const process = createSettingsProcess(repos, ["repo"]);
		const subjectId = settings.forProcess(process).context.repository;
		write(settings, { subjectId, key: model.key, value: "second" });
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
		for (const [overrides, modelProfileId, source] of [
			[{ process: { ...process, defaultModelProfileId: "second" } }, "second", "instance_default"],
			[
				{ process: { ...process, turnConfigsJson: '{"run":{"modelProfileId":"first"}}' } },
				"first",
				"instance_turn_config",
			],
			[{ modelOverride: "first" }, "first", "action_override"],
		] as const)
			expect(policy.evaluate({ ...request, ...overrides })).toMatchObject({
				selection: { modelProfileId, provenance: { source } },
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
		write(fixture.settings, { subjectId: "instance", key: model.key, value: "second" });
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

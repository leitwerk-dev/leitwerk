import { createCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "./database.js";
import { createAllRepos } from "./repositories.js";
import { skillRevisionDependencies } from "./schema.js";

describe("skill repository", () => {
	it("deduplicates canonical revisions and retains pinned revisions", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const first = createCanonicalPiResourceBundle([
			{ path: "skills/review/SKILL.md", content: Buffer.from("first") },
		]);
		const second = createCanonicalPiResourceBundle([
			{ path: "skills/review/SKILL.md", content: Buffer.from("second") },
		]);
		repos.skills.reconcile([
			{
				skillId: "review",
				label: "Review",
				description: null,
				bundle: first,
				sourceRevision: null,
			},
		]);
		const firstSelection = repos.skills.resolveActive(["review"]);
		const firstProcess = repos.processes.create({ processId: "test_process" });
		repos.processSkills.attach(firstProcess.id, firstSelection);
		repos.skills.reconcile([
			{
				skillId: "review",
				label: "Review",
				description: null,
				bundle: first,
				sourceRevision: null,
			},
		]);
		expect(repos.skills.resolveActive(["review"])).toEqual(firstSelection);

		repos.skills.reconcile([
			{
				skillId: "review",
				label: "Review",
				description: null,
				bundle: second,
				sourceRevision: "next",
			},
		]);
		const secondSelection = repos.skills.resolveActive(["review"]);
		const secondProcess = repos.processes.create({ processId: "test_process" });
		repos.processSkills.attach(secondProcess.id, secondSelection);
		expect(secondSelection[0]?.revisionId).not.toBe(firstSelection[0]?.revisionId);

		repos.skills.reconcile([]);
		expect(repos.skills.listAvailable()).toEqual([]);
		expect(
			repos.processSkills.listResourceLayers(firstProcess.id).map(({ bundle }) => bundle.digest),
		).toEqual([first.digest]);
		expect(
			repos.processSkills.listResourceLayers(secondProcess.id).map(({ bundle }) => bundle.digest),
		).toEqual([second.digest]);
	});

	it("registers remote candidates, reports attachment and invocation separately, and removes only future availability", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const bundle = createCanonicalPiResourceBundle([
			{ path: "skills/review/SKILL.md", content: Buffer.from("# Review") },
		]);
		repos.skills.mergeCatalog("shared", [
			{
				sourcePath: "skills/review",
				skillId: "review",
				label: "Review",
				description: "Review changes",
				bundle,
				sourceRevision: "abc123",
			},
		]);
		expect(repos.skills.catalog().availableSkills[0]).toMatchObject({
			registered: false,
			updateAvailable: false,
			usage: { attachedAllTime: 0, invokedAllTime: 0 },
		});

		repos.skills.registerCatalogEntry("shared", "review");
		const process = repos.processes.create({ processId: "test_process", title: "Review run" });
		repos.processSkills.attach(process.id, repos.skills.resolveActive(["review"]));
		repos.skills.recordInvocations({
			instanceId: process.id,
			turnRecordId: "turn_1",
			invocations: [{ skillId: "review", invokedAt: new Date().toISOString() }],
		});
		expect(repos.skills.catalog().availableSkills[0]).toMatchObject({
			registered: true,
			usage: { attachedAllTime: 1, invokedAllTime: 1 },
		});
		expect(repos.skills.getCatalogDetail("shared", "review")?.processes[0]).toMatchObject({
			instanceId: process.id,
			invocationCount: 1,
		});

		expect(repos.skills.remove("review")).toBe(true);
		expect(repos.skills.listAvailable()).toEqual([]);
		expect(repos.processSkills.listResourceLayers(process.id)[0]?.bundle.digest).toBe(
			bundle.digest,
		);
	});

	it("persists and selects referenced skills transitively", () => {
		const db = createInMemoryDatabase();
		const repos = createAllRepos(db);
		const candidate = (id: string, markdown: string) => ({
			sourcePath: `skills/${id}`,
			skillId: id,
			label: id,
			description: null,
			bundle: createCanonicalPiResourceBundle([
				{ path: `skills/${id}/SKILL.md`, content: Buffer.from(markdown) },
			]),
			sourceRevision: "abc123",
		});
		repos.skills.mergeCatalog("engineering", [
			candidate("parent", "Use /dependency."),
			candidate("dependency", "Use the `leaf` skill, then /parent."),
		]);
		repos.skills.mergeCatalog("productivity", [candidate("leaf", "# Leaf")]);

		repos.skills.registerCatalogEntry("engineering", "parent");

		expect(repos.skills.catalog().installedSkills.map((skill) => skill.id)).toEqual([
			"dependency",
			"leaf",
			"parent",
		]);
		expect(
			db
				.select({ dependencySkillId: skillRevisionDependencies.dependencySkillId })
				.from(skillRevisionDependencies)
				.all()
				.map((dependency) => dependency.dependencySkillId),
		).toEqual(expect.arrayContaining(["leaf", "parent", "dependency"]));
		db.delete(skillRevisionDependencies).run();
		repos.skills.backfillDependencies();
		expect(repos.skills.resolveActive(["parent"]).map((skill) => skill.skillId)).toEqual([
			"leaf",
			"dependency",
			"parent",
		]);
	});

	it("lists configuration skills and keeps discovered candidates after upstream removal", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const configuredBundle = createCanonicalPiResourceBundle([
			{ path: "skills/configured/SKILL.md", content: Buffer.from("# Configured") },
		]);
		repos.skills.reconcile([
			{
				skillId: "configured",
				label: "Configured",
				description: null,
				bundle: configuredBundle,
				sourceRevision: null,
			},
		]);
		expect(repos.skills.catalog().installedSkills).toEqual([
			expect.objectContaining({ id: "configured", registrationKind: "configuration" }),
		]);
		expect(repos.skills.getInstalledDetail("configured")?.skillMarkdown).toBe("# Configured");

		const remoteBundle = createCanonicalPiResourceBundle([
			{ path: "skills/remote/SKILL.md", content: Buffer.from("# Remote") },
		]);
		repos.skills.mergeCatalog("shared", [
			{
				sourcePath: "skills/remote",
				skillId: "remote",
				label: "Remote",
				description: null,
				bundle: remoteBundle,
				sourceRevision: "abc123",
			},
		]);
		repos.skills.registerCatalogEntry("shared", "remote");
		repos.skills.mergeCatalog("shared", []);

		expect(repos.skills.catalog().availableSkills).toEqual([
			expect.objectContaining({
				id: "remote",
				registered: true,
				stale: true,
			}),
		]);
		expect(repos.skills.catalog().installedSkills).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "remote", registrationKind: "catalog" }),
			]),
		);
	});

	it("loads resource layers for a process's pinned revisions", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const bundle = createCanonicalPiResourceBundle([
			{ path: "skills/review/SKILL.md", content: Buffer.from("review") },
		]);
		repos.skills.reconcile([
			{
				skillId: "review",
				label: "Review",
				description: null,
				bundle,
				sourceRevision: null,
			},
		]);
		const process = repos.processes.create({
			processId: "test_process",
			lifecycleStatus: "active",
		});
		repos.processSkills.attach(process.id, repos.skills.resolveActive(["review"]));

		expect(repos.processSkills.listResourceLayers(process.id)).toEqual([
			{
				bundle: { digest: bundle.digest, bytes: Buffer.from(bundle.bytes) },
				owner: { kind: "skill", ownerExtensionId: null, packageName: null },
			},
		]);
	});
});

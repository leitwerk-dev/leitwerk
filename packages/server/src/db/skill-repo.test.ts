import { createCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "./database.js";
import { createAllRepos } from "./repositories.js";
import { skillRevisionDependencies, skillRevisions, skills } from "./schema.js";

function candidate(id: string, markdown: string, sourceRevision = "abc123") {
	return {
		sourcePath: `skills/${id}`,
		skillId: id,
		label: id,
		description: null,
		bundle: createCanonicalPiResourceBundle([
			{ path: `skills/${id}/SKILL.md`, content: Buffer.from(markdown) },
		]),
		sourceRevision,
	};
}

function install(
	repos: ReturnType<typeof createAllRepos>,
	repositoryId: string,
	item: ReturnType<typeof candidate>,
): void {
	repos.skills.mergeCatalog(repositoryId, [item]);
	repos.skills.registerCatalogEntry(repositoryId, item.skillId);
}

describe("skill repository", () => {
	it("deduplicates canonical revisions and retains pinned revisions", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const first = candidate("review", "first", "first");
		install(repos, "shared", first);
		const firstSelection = repos.skills.resolveActive(["review"]);
		const firstProcess = repos.processes.create({ processId: "test_process" });
		repos.processSkills.attach(firstProcess.id, firstSelection);

		repos.skills.registerCatalogEntry("shared", "review");
		expect(repos.skills.resolveActive(["review"])).toEqual(firstSelection);

		const second = candidate("review", "second", "next");
		install(repos, "shared", second);
		const secondSelection = repos.skills.resolveActive(["review"]);
		const secondProcess = repos.processes.create({ processId: "test_process" });
		repos.processSkills.attach(secondProcess.id, secondSelection);
		expect(secondSelection[0]?.revisionId).not.toBe(firstSelection[0]?.revisionId);

		expect(repos.skills.remove("review")).toBe(true);
		expect(repos.skills.listAvailable()).toEqual([]);
		expect(
			repos.processSkills.listResourceLayers(firstProcess.id).map(({ bundle }) => bundle.digest),
		).toEqual([first.bundle.digest]);
		expect(
			repos.processSkills.listResourceLayers(secondProcess.id).map(({ bundle }) => bundle.digest),
		).toEqual([second.bundle.digest]);
	});

	it("registers remote candidates, reports usage, and removes only future availability", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const review = { ...candidate("review", "# Review"), description: "Review changes" };
		repos.skills.mergeCatalog("shared", [review]);
		expect(repos.skills.catalog().availableSkills[0]).toMatchObject({
			registered: false,
			updateAvailable: false,
			modelInvocable: true,
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
			review.bundle.digest,
		);
	});

	it("persists and selects referenced skills transitively", () => {
		const db = createInMemoryDatabase();
		const repos = createAllRepos(db);
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

	it("reports model invocation availability for stale and installed skills", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const remote = candidate("remote", "---\ndisable-model-invocation: true\n---\n# Remote");
		install(repos, "shared", remote);
		repos.skills.mergeCatalog("shared", []);

		expect(repos.skills.catalog().availableSkills).toEqual([
			expect.objectContaining({
				id: "remote",
				registered: true,
				stale: true,
				modelInvocable: false,
			}),
		]);
		expect(repos.skills.catalog().installedSkills).toEqual([
			expect.objectContaining({ id: "remote", modelInvocable: false }),
		]);
	});

	it("deactivates skills left by direct configuration", () => {
		const db = createInMemoryDatabase();
		const repos = createAllRepos(db);
		const bundle = candidate("legacy", "# Legacy").bundle;
		db.insert(skills)
			.values({
				id: "legacy",
				label: "Legacy",
				registrationKind: "configuration",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			})
			.run();
		db.insert(skillRevisions)
			.values({
				id: "skillrev_legacy",
				skillId: "legacy",
				bundleDigest: bundle.digest,
				bundleBytes: Buffer.from(bundle.bytes),
				importedAt: "2026-01-01T00:00:00.000Z",
			})
			.run();
		db.update(skills).set({ activeRevisionId: "skillrev_legacy" }).run();

		repos.skills.deactivateConfiguredSkills();

		expect(db.select().from(skills).get()?.activeRevisionId).toBeNull();
	});

	it("loads resource layers for a process's pinned revisions", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const review = candidate("review", "review");
		install(repos, "shared", review);
		const process = repos.processes.create({
			processId: "test_process",
			lifecycleStatus: "active",
		});
		repos.processSkills.attach(process.id, repos.skills.resolveActive(["review"]));

		expect(repos.processSkills.listResourceLayers(process.id)).toEqual([
			{
				bundle: { digest: review.bundle.digest, bytes: Buffer.from(review.bundle.bytes) },
				owner: { kind: "skill", ownerExtensionId: null, packageName: null },
			},
		]);
	});
});

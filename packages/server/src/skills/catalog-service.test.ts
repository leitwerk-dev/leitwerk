import { createCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "../db/database.js";
import { createAllRepos } from "../db/repositories.js";
import { createSkillCatalogService } from "./catalog-service.js";

function importedSkill(revision: string) {
	const skillMarkdown = `# Review ${revision}`;
	return {
		sourcePath: "skills/review",
		skillId: "review",
		label: "Review",
		description: "Review changes",
		bundle: createCanonicalPiResourceBundle([
			{ path: "skills/review/SKILL.md", content: Buffer.from(skillMarkdown) },
		]),
		sourceRevision: revision,
	};
}

describe("skill catalog service", () => {
	it("preserves partial results, exposes updates, and keeps installed skills after remote removal", async () => {
		const repos = createAllRepos(createInMemoryDatabase());
		let revision = "revision-1";
		let remoteSkills = [importedSkill(revision)];
		const service = createSkillCatalogService({
			repositories: [
				{ id: "shared", url: "https://example.test/shared.git", ref: "main" },
				{ id: "broken", url: "https://example.test/broken.git", ref: "main" },
			],
			repos,
			importRepository: async (repository) => {
				if (repository.id === "broken") throw new Error("repository unavailable");
				return { commit: revision, skills: remoteSkills };
			},
		});

		const first = await service.refresh();
		expect(first.availableSkills).toHaveLength(1);
		expect(first.repositories.find((repository) => repository.id === "broken")?.error).toBe(
			"repository unavailable",
		);

		service.register("shared", "review");
		expect(service.list().installedSkills).toEqual([
			expect.objectContaining({ id: "review", updateAvailable: false }),
		]);

		revision = "revision-2";
		remoteSkills = [importedSkill(revision)];
		await service.refresh();
		expect(service.list().installedSkills[0]).toMatchObject({
			id: "review",
			updateAvailable: true,
			sourceRepositoryId: "shared",
		});

		remoteSkills = [];
		await service.refresh();
		expect(service.list().availableSkills).toEqual([]);
		expect(service.list().installedSkills).toEqual([expect.objectContaining({ id: "review" })]);
	});

	it("removes never-installed candidates after repository configuration is removed", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		repos.skills.mergeCatalog("removed", [importedSkill("revision-1")]);
		const service = createSkillCatalogService({ repositories: [], repos });

		expect(service.list().availableSkills).toEqual([]);
		expect(() => service.register("removed", "review")).toThrow("no longer available");
	});

	it("scopes duplicate remote ids by repository", async () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const candidateA = importedSkill("one");
		const candidateB = importedSkill("two");
		repos.skills.mergeCatalog("one", [candidateA]);
		repos.skills.mergeCatalog("two", [candidateB]);
		const service = createSkillCatalogService({
			repositories: [
				{ id: "one", url: "https://example.test/one.git", ref: "main" },
				{ id: "two", url: "https://example.test/two.git", ref: "main" },
			],
			repos,
		});
		expect(service.list().availableSkills).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ repositoryId: "one", id: "review" }),
				expect.objectContaining({ repositoryId: "two", id: "review" }),
			]),
		);
		expect(() => service.register("one", "review")).not.toThrow();
	});
});

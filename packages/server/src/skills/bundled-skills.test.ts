import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CatalogPiContribution } from "@leitwerk-dev/extension-runtime";
import { describe, expect, it, onTestFinished } from "vitest";
import { importBundledSkills } from "./bundled-skills.js";

async function fixture(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "leitwerk-bundled-skills-"));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	return root;
}

function contribution(root: string, owner: string): CatalogPiContribution {
	return {
		ownerExtensionId: owner,
		packageName: `@example/${owner}`,
		resources: { skillDirectories: [root], promptDirectories: [] },
	};
}

describe("bundled skill discovery", () => {
	it("discovers skills from multiple extensions with instructions and complete bundle digests", async () => {
		const root = await fixture();
		const publicRoot = path.join(root, "public");
		const privateRoot = path.join(root, "private");
		await mkdir(path.join(publicRoot, "writing", "references"), { recursive: true });
		await mkdir(path.join(privateRoot, "registry"), { recursive: true });
		await writeFile(
			path.join(publicRoot, "writing", "SKILL.md"),
			"---\nname: Writing\ndescription: >-\n  Write technical\n  documentation.\n---\n# Writing\n",
		);
		const reference = path.join(publicRoot, "writing", "references", "rules.md");
		await writeFile(reference, "Writing rules");
		await writeFile(
			path.join(privateRoot, "registry", "SKILL.md"),
			"---\nname: Registry\ndisable-model-invocation: true\n---\n# Registry\n",
		);
		const contributions = [
			contribution(publicRoot, "public-skills"),
			contribution(privateRoot, "private-skills"),
		];
		const imported = await importBundledSkills(contributions);
		expect(imported).toEqual([
			expect.objectContaining({
				id: "registry",
				label: "Registry",
				registrationKind: "bundled",
				sourceExtensionId: "private-skills",
				modelInvocable: false,
			}),
			expect.objectContaining({
				id: "writing",
				label: "Writing",
				description: "Write technical documentation.",
				sourceExtensionId: "public-skills",
				modelInvocable: true,
				skillMarkdown: expect.stringContaining("# Writing"),
			}),
		]);
		await writeFile(reference, "Updated writing rules");
		const updated = await importBundledSkills(contributions);
		expect(updated[1]?.activeRevisionId).not.toBe(imported[1]?.activeRevisionId);
		expect(updated[0]?.activeRevisionId).toBe(imported[0]?.activeRevisionId);
	});

	it("rejects ambiguous skill ids across nested directories", async () => {
		const root = await fixture();
		for (const group of ["one", "two"]) {
			await mkdir(path.join(root, group, "review"), { recursive: true });
			await writeFile(path.join(root, group, "review", "SKILL.md"), "# Review\n");
		}
		await expect(importBundledSkills([contribution(root, "skills")])).rejects.toThrow(
			"Duplicate bundled skill id 'review'",
		);
	});

	it("rejects skill resources that worker snapshots would reject", async () => {
		const root = await fixture();
		await mkdir(path.join(root, "skills", "review"), { recursive: true });
		await writeFile(path.join(root, "outside.md"), "Outside");
		await symlink(path.join(root, "outside.md"), path.join(root, "skills", "review", "SKILL.md"));
		await expect(
			importBundledSkills([contribution(path.join(root, "skills"), "skills")]),
		).rejects.toThrow("Symbolic links are forbidden");
	});
});

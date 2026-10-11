import path from "node:path";
import type { CatalogPiContribution } from "@leitwerk-dev/extension-runtime";
import type { InstalledSkillCatalogDetail } from "@leitwerk-dev/protocol";
import { createCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { ResourceCollector } from "../pi-resources/resource-collector.js";
import { isSkillModelInvocable, skillMetadata } from "./skill-frontmatter.js";
import { SAFE_SKILL_ID_PATTERN } from "./skill-id.js";

/** Read the same declared skill directories used by worker snapshots. @internal */
export async function importBundledSkills(
	contributions: readonly CatalogPiContribution[],
): Promise<InstalledSkillCatalogDetail[]> {
	const skills = new Map<string, InstalledSkillCatalogDetail>();
	const collector = new ResourceCollector();
	for (const contribution of contributions) {
		for (const directory of contribution.resources.skillDirectories) {
			await collector.addDirectory(directory, "skills", {
				kind: "skill",
				ownerExtensionId: contribution.ownerExtensionId,
				packageName: contribution.packageName,
			});
		}
	}
	const files = collector.toResourceFiles();
	for (const file of files) {
		if (!file.path.endsWith("/SKILL.md")) continue;
		const skillRoot = path.posix.dirname(file.path);
		const skillId = path.posix.basename(skillRoot);
		if (!SAFE_SKILL_ID_PATTERN.test(skillId)) {
			throw new Error(`Bundled skill has an invalid id '${skillId}' at '${file.path}'`);
		}
		if (skills.has(skillId)) throw new Error(`Duplicate bundled skill id '${skillId}'`);
		const skillMarkdown = Buffer.from(file.content).toString("utf8");
		const metadata = skillMetadata(skillMarkdown);
		const sourceExtensionId = collector.provenance.find(
			(source) => source.snapshotPath === file.path,
		)?.ownerExtensionId;
		const bundle = createCanonicalPiResourceBundle(
			files.filter((candidate) => candidate.path.startsWith(`${skillRoot}/`)),
		);
		skills.set(skillId, {
			id: skillId,
			label: metadata.name ?? skillId,
			description: metadata.description,
			registrationKind: "bundled",
			...(sourceExtensionId ? { sourceExtensionId } : {}),
			activeRevisionId: bundle.digest,
			activeSourceRevision: null,
			sourceRepositoryId: null,
			updateAvailable: false,
			modelInvocable: isSkillModelInvocable(skillMarkdown),
			usage: {
				attachedAllTime: 0,
				attachedLast30Days: 0,
				invokedAllTime: 0,
				invokedLast30Days: 0,
			},
			skillMarkdown,
			processes: [],
			revisions: [],
		});
	}
	return [...skills.values()];
}

import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { LoadedExtensionModule } from "@leitwerk-dev/extension-runtime";
import { parseSkillPackManifest, type SkillRevisionProvenance } from "@leitwerk-dev/protocol";
import { createCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { parse as parseYaml } from "yaml";
import { ResourceCollector } from "../pi-resources/resource-collector.js";
import type { ImportedSkill } from "./source-importer.js";

/** @internal */
export interface ImportedExtensionSkill extends ImportedSkill {
	/** @internal */
	provenance: SkillRevisionProvenance;
}

async function packagePath(packageRoot: string, target: string): Promise<string> {
	const relative = path.relative(packageRoot, target);
	if (
		!relative ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error(`Skill-pack path escapes package: ${target}`);
	}
	let current = packageRoot;
	for (const part of relative.split(path.sep)) {
		current = path.join(current, part);
		if ((await lstat(current)).isSymbolicLink())
			throw new Error(`Skill-pack symlink is forbidden: ${current}`);
	}
	return current;
}

/** Import only declared packages; no network or patch execution at runtime. @internal */
export async function importExtensionSkills(
	modules: readonly LoadedExtensionModule[],
): Promise<ImportedExtensionSkill[]> {
	const imported: ImportedExtensionSkill[] = [];
	for (const loaded of modules) {
		if (!loaded.skillPackPath) continue;
		const packageRoot = await realpath(loaded.packageDir);
		const manifestPath = await packagePath(
			packageRoot,
			path.resolve(packageRoot, path.relative(loaded.packageDir, loaded.skillPackPath)),
		);
		const manifest = parseSkillPackManifest(JSON.parse(await readFile(manifestPath, "utf8")));
		for (const skill of manifest.skills) {
			const directory = await packagePath(
				packageRoot,
				path.resolve(path.dirname(manifestPath), skill.directory),
			);
			const provenance: SkillRevisionProvenance = {
				extensionId: loaded.module.manifest.id,
				packageName: loaded.packageName,
				packageVersion: loaded.packageVersion ?? loaded.module.manifest.version,
				upstream: manifest.upstream,
				sourcePath: skill.sourcePath,
				patchDigest: manifest.patchDigest,
				dependencies: skill.dependencies,
			};
			const collector = new ResourceCollector();
			await collector.addDirectory(
				directory,
				`skills/${skill.id}`,
				{
					kind: "skill",
					ownerExtensionId: provenance.extensionId,
					packageName: provenance.packageName,
				},
				{ forbiddenNames: new Set([".git", ".leitwerk-skill.json"]) },
			);
			const markdown = collector.files.get(`skills/${skill.id}/SKILL.md`);
			const header =
				markdown &&
				/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(Buffer.from(markdown).toString("utf8"));
			const metadata = header ? parseYaml(header[1]) : null;
			if (metadata?.name !== skill.id || metadata.description !== skill.description) {
				throw new Error(`Skill '${skill.id}' frontmatter does not match its pack manifest`);
			}
			// Include dependency/provenance changes in revision identity even when prose is unchanged.
			collector.addBytes(
				`skills/${skill.id}/.leitwerk-skill.json`,
				Buffer.from(JSON.stringify(provenance)),
			);
			imported.push({
				skillId: skill.id,
				label: skill.label,
				description: skill.description,
				sourceRevision: manifest.upstream.commit,
				provenance,
				bundle: createCanonicalPiResourceBundle(collector.toResourceFiles()),
			});
		}
	}
	return imported;
}

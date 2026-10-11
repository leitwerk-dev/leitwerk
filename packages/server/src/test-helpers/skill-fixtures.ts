import { createCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import type { RepositoryBundle } from "../db/repositories.js";

/** Installs a synthetic catalog skill using the operator registration path. @internal */
export function installTestSkill(
	repos: Pick<RepositoryBundle, "skills">,
	id: string,
	content = "Synthetic skill instructions.",
) {
	const repositoryId = `test-${id}`;
	repos.skills.mergeCatalog(repositoryId, [
		{
			skillId: id,
			label: id,
			description: "Synthetic skill",
			sourcePath: `skills/${id}`,
			sourceRevision: null,
			bundle: createCanonicalPiResourceBundle([
				{
					path: `skills/${id}/SKILL.md`,
					content: Buffer.from(`---\nname: ${id}\ndescription: Synthetic skill\n---\n${content}\n`),
				},
			]),
		},
	]);
	repos.skills.registerCatalogEntry(repositoryId, id);
	return repos.skills.resolveActive([id]);
}

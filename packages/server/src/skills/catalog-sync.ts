import type { SkillConfig } from "../config/config-types.js";
import type { RepositoryBundle } from "../db/repositories.js";
import { importConfiguredSkills } from "./source-importer.js";

/** Reads every source before entering the single catalog reconciliation transaction. */
export async function syncConfiguredSkillCatalog(input: {
	skills: readonly SkillConfig[];
	configRoot: string;
	repos: RepositoryBundle;
}): Promise<void> {
	const imported = await importConfiguredSkills(input.skills, input.configRoot);
	input.repos.transaction((repos) => repos.skills.reconcile(imported));
}

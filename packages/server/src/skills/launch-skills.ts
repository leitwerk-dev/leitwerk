import type { SkillSelection } from "@leitwerk-dev/protocol";
import type { LeitwerkConfig } from "../config/config-types.js";
import type { RepositoryBundle } from "../db/repositories.js";

/** Server-owned defaults, resolved only when selecting skills for a new launch. @internal */
export type LaunchSkillDefaults = Pick<LeitwerkConfig, "default_skills" | "process_configs">;

/** @internal */
export function resolveLaunchSkills(
	deps: { skills: RepositoryBundle["skills"]; skillDefaults?: LaunchSkillDefaults },
	processId: string,
	selectedSkillIds: readonly string[] = [],
): SkillSelection[] {
	const defaults =
		deps.skillDefaults?.process_configs?.[processId]?.default_skills ??
		deps.skillDefaults?.default_skills ??
		[];
	return deps.skills.resolveActive([...new Set([...defaults, ...selectedSkillIds])]);
}

import type { SkillSelection } from "@leitwerk-dev/protocol";
import { asc, eq } from "drizzle-orm";
import { type PiResourceLayer, SKILL_RESOURCE_OWNER } from "../pi-resources/resource-collector.js";
import type { LeitwerkDb } from "./database.js";
import { processSkills, skillRevisions } from "./schema.js";

export function createProcessSkillRepo(db: LeitwerkDb) {
	return {
		attach(instanceId: string, selections: readonly SkillSelection[]): void {
			const seen = new Set<string>();
			selections.forEach((selection, position) => {
				if (seen.has(selection.skillId))
					throw new Error(`Duplicate skill selection '${selection.skillId}'`);
				seen.add(selection.skillId);
				const revision = db
					.select()
					.from(skillRevisions)
					.where(eq(skillRevisions.id, selection.revisionId))
					.get();
				if (!revision || revision.skillId !== selection.skillId)
					throw new Error(`Invalid revision for skill '${selection.skillId}'`);
				db.insert(processSkills)
					.values({
						instanceId,
						skillId: selection.skillId,
						skillRevisionId: selection.revisionId,
						position,
					})
					.run();
			});
		},
		listSelections(instanceId: string): SkillSelection[] {
			return db
				.select({
					skillId: processSkills.skillId,
					revisionId: processSkills.skillRevisionId,
				})
				.from(processSkills)
				.where(eq(processSkills.instanceId, instanceId))
				.orderBy(asc(processSkills.position))
				.all();
		},
		listResourceLayers(instanceId: string): PiResourceLayer[] {
			return db
				.select({
					digest: skillRevisions.bundleDigest,
					bytes: skillRevisions.bundleBytes,
				})
				.from(processSkills)
				.innerJoin(skillRevisions, eq(processSkills.skillRevisionId, skillRevisions.id))
				.where(eq(processSkills.instanceId, instanceId))
				.orderBy(asc(processSkills.position))
				.all()
				.map(({ digest, bytes }) => ({
					bundle: { digest, bytes },
					owner: SKILL_RESOURCE_OWNER,
				}));
		},
	};
}

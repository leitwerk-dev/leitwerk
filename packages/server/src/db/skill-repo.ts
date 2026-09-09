import type {
	InstalledSkillCatalogDetail,
	InstalledSkillCatalogItem,
	SkillCatalogDetail,
	SkillCatalogItem,
	SkillOptionSummary,
	SkillSelection,
	SkillUsageProcessSummary,
	SkillUsageSummary,
} from "@leitwerk-dev/protocol";
import { verifyCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { and, asc, count, desc, eq, isNotNull, max, notExists, notInArray, sql } from "drizzle-orm";
import { explicitSkillReferenceIds, referencedSkillIds } from "../skills/skill-dependencies.js";
import { isSkillModelInvocable } from "../skills/skill-frontmatter.js";
import type { ImportedRepositorySkill, ImportedSkill } from "../skills/source-importer.js";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import {
	processInstances,
	processSkills,
	skillCatalogEntries,
	skillInvocations,
	skillRevisionDependencies,
	skillRevisions,
	skills,
} from "./schema.js";

function revisionForBundle(db: LeitwerkDb, item: ImportedSkill, timestamp: string): string {
	const existing = db
		.select({ id: skillRevisions.id })
		.from(skillRevisions)
		.where(
			and(
				eq(skillRevisions.skillId, item.skillId),
				eq(skillRevisions.bundleDigest, item.bundle.digest),
			),
		)
		.get();
	if (existing) return existing.id;
	const id = generateId("skillrev");
	db.insert(skillRevisions)
		.values({
			id,
			skillId: item.skillId,
			bundleDigest: item.bundle.digest,
			bundleBytes: Buffer.from(item.bundle.bytes),
			sourceRevision: item.sourceRevision,
			importedAt: timestamp,
		})
		.run();
	return id;
}

function emptyUsage(): SkillUsageSummary {
	return {
		attachedAllTime: 0,
		attachedLast30Days: 0,
		invokedAllTime: 0,
		invokedLast30Days: 0,
	};
}

function usageBySkill(db: LeitwerkDb): Map<string, SkillUsageSummary> {
	const result = new Map<string, SkillUsageSummary>();
	const usage = (skillId: string) => result.get(skillId) ?? emptyUsage();
	const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	for (const row of db
		.select({
			skillId: processSkills.skillId,
			allTime: count(),
			last30Days: sql<number>`sum(case when ${processInstances.createdAt} >= ${cutoff} then 1 else 0 end)`,
		})
		.from(processSkills)
		.innerJoin(processInstances, eq(processSkills.instanceId, processInstances.id))
		.groupBy(processSkills.skillId)
		.all()) {
		result.set(row.skillId, {
			...usage(row.skillId),
			attachedAllTime: row.allTime,
			attachedLast30Days: row.last30Days,
		});
	}
	for (const row of db
		.select({
			skillId: skillInvocations.skillId,
			allTime: count(),
			last30Days: sql<number>`sum(case when ${skillInvocations.invokedAt} >= ${cutoff} then 1 else 0 end)`,
		})
		.from(skillInvocations)
		.groupBy(skillInvocations.skillId)
		.all()) {
		result.set(row.skillId, {
			...usage(row.skillId),
			invokedAllTime: row.allTime,
			invokedLast30Days: row.last30Days,
		});
	}
	return result;
}

function processUsage(db: LeitwerkDb, skillId: string): SkillUsageProcessSummary[] {
	return db
		.select({
			instanceId: processSkills.instanceId,
			title: sql<string>`coalesce(${processInstances.title}, ${processInstances.externalId}, ${processInstances.id})`,
			attachedAt: processInstances.createdAt,
			invocationCount: count(skillInvocations.skillId),
			lastInvokedAt: max(skillInvocations.invokedAt),
		})
		.from(processSkills)
		.innerJoin(processInstances, eq(processSkills.instanceId, processInstances.id))
		.leftJoin(
			skillInvocations,
			and(
				eq(skillInvocations.instanceId, processSkills.instanceId),
				eq(skillInvocations.skillId, processSkills.skillId),
			),
		)
		.where(eq(processSkills.skillId, skillId))
		.groupBy(
			processSkills.instanceId,
			processInstances.title,
			processInstances.externalId,
			processInstances.id,
			processInstances.createdAt,
		)
		.orderBy(desc(processInstances.createdAt))
		.all();
}

function skillMarkdown(skillId: string, bytes: Uint8Array, digest: string): string {
	const file = verifyCanonicalPiResourceBundle(bytes, digest).find(
		(candidate) => candidate.path === `skills/${skillId}/SKILL.md`,
	);
	return file ? Buffer.from(file.content).toString("utf8") : "";
}

function pruneNeverInstalledCatalogEntries(db: LeitwerkDb): void {
	db.delete(skillCatalogEntries)
		.where(
			and(
				eq(skillCatalogEntries.available, false),
				notExists(
					db
						.select({ id: skillRevisions.id })
						.from(skillRevisions)
						.where(
							and(
								eq(skillRevisions.skillId, skillCatalogEntries.skillId),
								eq(skillRevisions.bundleDigest, skillCatalogEntries.bundleDigest),
							),
						),
				),
			),
		)
		.run();
}

function recordRevisionDependencies(db: LeitwerkDb, revisionId: string, markdown: string): void {
	db.delete(skillRevisionDependencies)
		.where(eq(skillRevisionDependencies.skillRevisionId, revisionId))
		.run();
	for (const [position, dependencySkillId] of explicitSkillReferenceIds(markdown).entries()) {
		db.insert(skillRevisionDependencies)
			.values({ skillRevisionId: revisionId, dependencySkillId, position })
			.run();
	}
}

function activateSkill(
	db: LeitwerkDb,
	item: ImportedSkill,
	registrationKind: "configuration" | "catalog",
	timestamp: string,
	markdown = skillMarkdown(item.skillId, item.bundle.bytes, item.bundle.digest),
): string {
	db.insert(skills)
		.values({
			id: item.skillId,
			label: item.label,
			description: item.description,
			activeRevisionId: null,
			registrationKind,
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.onConflictDoNothing()
		.run();
	const revisionId = revisionForBundle(db, item, timestamp);
	recordRevisionDependencies(db, revisionId, markdown);
	db.update(skills)
		.set({
			label: item.label,
			description: item.description,
			activeRevisionId: revisionId,
			registrationKind,
			updatedAt: timestamp,
		})
		.where(eq(skills.id, item.skillId))
		.run();
	return revisionId;
}

function catalogView(db: LeitwerkDb): {
	availableSkills: SkillCatalogItem[];
	installedSkills: InstalledSkillCatalogItem[];
} {
	const candidates = db.select().from(skillCatalogEntries).all();
	const usage = usageBySkill(db);
	const installedRows = db
		.select({
			id: skills.id,
			label: skills.label,
			description: skills.description,
			activeRevisionId: skillRevisions.id,
			activeSourceRevision: skillRevisions.sourceRevision,
			activeDigest: skillRevisions.bundleDigest,
			activeBundleBytes: skillRevisions.bundleBytes,
			registrationKind: skills.registrationKind,
		})
		.from(skills)
		.innerJoin(skillRevisions, eq(skills.activeRevisionId, skillRevisions.id))
		.orderBy(asc(skills.label), asc(skills.id))
		.all();
	const installedById = new Map(installedRows.map((row) => [row.id, row]));
	const availableSkills = candidates.map((candidate) => {
		const active = installedById.get(candidate.skillId);
		const registered = Boolean(
			active?.registrationKind === "catalog" && active.activeDigest === candidate.bundleDigest,
		);
		return {
			repositoryId: candidate.repositoryId,
			id: candidate.skillId,
			label: candidate.label,
			description: candidate.description,
			sourcePath: candidate.sourcePath,
			sourceRevision: candidate.sourceRevision,
			registered,
			updateAvailable: Boolean(
				candidate.available && active?.registrationKind === "catalog" && !registered,
			),
			conflict: candidate.available && active?.registrationKind === "configuration",
			stale: !candidate.available,
			modelInvocable: isSkillModelInvocable(
				skillMarkdown(candidate.skillId, candidate.bundleBytes, candidate.bundleDigest),
			),
			usage: usage.get(candidate.skillId) ?? emptyUsage(),
		};
	});
	const installedSkills = installedRows.map((skill) => {
		const matching = candidates.filter((candidate) => candidate.skillId === skill.id);
		const available = matching.filter((candidate) => candidate.available);
		const activeSource = matching.filter(
			(candidate) => candidate.bundleDigest === skill.activeDigest,
		);
		return {
			id: skill.id,
			label: skill.label,
			description: skill.description,
			activeRevisionId: skill.activeRevisionId,
			activeSourceRevision: skill.activeSourceRevision,
			registrationKind: skill.registrationKind,
			sourceRepositoryId:
				matching.length === 1
					? (matching[0]?.repositoryId ?? null)
					: activeSource.length === 1
						? (activeSource[0]?.repositoryId ?? null)
						: null,
			updateAvailable:
				skill.registrationKind === "catalog" &&
				available.length === 1 &&
				available[0]?.bundleDigest !== skill.activeDigest,
			modelInvocable: isSkillModelInvocable(
				skillMarkdown(skill.id, skill.activeBundleBytes, skill.activeDigest),
			),
			usage: usage.get(skill.id) ?? emptyUsage(),
		};
	});
	return { availableSkills, installedSkills };
}

export function createSkillRepo(db: LeitwerkDb) {
	return {
		listAvailable(): SkillOptionSummary[] {
			return db
				.select({ id: skills.id, label: skills.label, description: skills.description })
				.from(skills)
				.where(isNotNull(skills.activeRevisionId))
				.orderBy(asc(skills.label), asc(skills.id))
				.all();
		},
		resolveActive(ids: readonly string[]): SkillSelection[] {
			const activeSkills = db
				.select({ id: skills.id, revisionId: skillRevisions.id })
				.from(skills)
				.innerJoin(skillRevisions, eq(skills.activeRevisionId, skillRevisions.id))
				.all();
			const byId = new Map(activeSkills.map((skill) => [skill.id, skill]));
			const dependencies = new Map<string, string[]>();
			for (const dependency of db.select().from(skillRevisionDependencies).all()) {
				const ids = dependencies.get(dependency.skillRevisionId) ?? [];
				ids[dependency.position] = dependency.dependencySkillId;
				dependencies.set(dependency.skillRevisionId, ids);
			}
			const resolved = new Map<string, SkillSelection>();
			const visiting = new Set<string>();
			const add = (id: string): void => {
				if (resolved.has(id) || visiting.has(id)) return;
				const skill = byId.get(id);
				if (!skill) throw new Error(`Unknown or unavailable skill '${id}'`);
				visiting.add(id);
				for (const dependencyId of dependencies.get(skill.revisionId) ?? []) {
					if (dependencyId !== id && byId.has(dependencyId)) add(dependencyId);
				}
				visiting.delete(id);
				resolved.set(id, { skillId: id, revisionId: skill.revisionId });
			};
			for (const id of ids) add(id);
			return [...resolved.values()];
		},
		reconcile(imported: readonly ImportedSkill[]): void {
			const timestamp = now();
			db.update(skills)
				.set({ activeRevisionId: null, updatedAt: timestamp })
				.where(
					and(
						eq(skills.registrationKind, "configuration"),
						notInArray(
							skills.id,
							imported.map((item) => item.skillId),
						),
					),
				)
				.run();
			for (const item of imported) activateSkill(db, item, "configuration", timestamp);
		},
		backfillDependencies(): void {
			for (const revision of db.select().from(skillRevisions).all()) {
				recordRevisionDependencies(
					db,
					revision.id,
					skillMarkdown(revision.skillId, revision.bundleBytes, revision.bundleDigest),
				);
			}
		},
		markUnconfiguredCatalogEntries(configuredRepositoryIds: readonly string[]): void {
			db.update(skillCatalogEntries)
				.set({ available: false })
				.where(notInArray(skillCatalogEntries.repositoryId, [...configuredRepositoryIds]))
				.run();
			pruneNeverInstalledCatalogEntries(db);
		},
		mergeCatalog(repositoryId: string, imported: readonly ImportedRepositorySkill[]): void {
			const timestamp = now();
			db.update(skillCatalogEntries)
				.set({ available: false })
				.where(eq(skillCatalogEntries.repositoryId, repositoryId))
				.run();
			for (const item of imported) {
				const values = {
					label: item.label,
					description: item.description,
					sourcePath: item.sourcePath,
					sourceRevision: item.sourceRevision ?? "",
					bundleDigest: item.bundle.digest,
					bundleBytes: Buffer.from(item.bundle.bytes),
					discoveredAt: timestamp,
					available: true,
				};
				db.insert(skillCatalogEntries)
					.values({ repositoryId, skillId: item.skillId, ...values })
					.onConflictDoUpdate({
						target: [skillCatalogEntries.repositoryId, skillCatalogEntries.skillId],
						set: values,
					})
					.run();
			}
			pruneNeverInstalledCatalogEntries(db);
		},
		registerCatalogEntry(repositoryId: string, skillId: string): string {
			const candidates = db
				.select()
				.from(skillCatalogEntries)
				.where(eq(skillCatalogEntries.available, true))
				.all();
			const availableIds = new Set(candidates.map((candidate) => candidate.skillId));
			const installedIds = new Set(
				db
					.select({ id: skills.id })
					.from(skills)
					.where(isNotNull(skills.activeRevisionId))
					.all()
					.map((skill) => skill.id),
			);
			const visiting = new Set<string>();
			const timestamp = now();

			const install = (id: string, requestedRepositoryId?: string): string | null => {
				if (!requestedRepositoryId && installedIds.has(id)) return null;
				if (visiting.has(id)) return null;
				const matches = candidates.filter((candidate) => candidate.skillId === id);
				const candidate = requestedRepositoryId
					? matches.find((match) => match.repositoryId === requestedRepositoryId)
					: matches.length === 1
						? matches[0]
						: undefined;
				if (!requestedRepositoryId && matches.length > 1) {
					throw new Error(`Remote skill '${id}' has conflicting repository candidates`);
				}
				if (!candidate) {
					throw new Error(
						`Remote skill '${requestedRepositoryId ? `${requestedRepositoryId}/` : ""}${id}' is no longer available`,
					);
				}
				const current = db.select().from(skills).where(eq(skills.id, id)).get();
				if (current?.activeRevisionId && current.registrationKind === "configuration") {
					throw new Error(`Skill '${id}' is managed by configuration`);
				}
				visiting.add(id);
				const markdown = skillMarkdown(id, candidate.bundleBytes, candidate.bundleDigest);
				for (const dependencyId of referencedSkillIds(markdown, availableIds)) {
					if (dependencyId !== id) install(dependencyId);
				}
				visiting.delete(id);

				const revisionId = activateSkill(
					db,
					{
						skillId: id,
						label: candidate.label,
						description: candidate.description,
						bundle: { digest: candidate.bundleDigest, bytes: candidate.bundleBytes },
						sourceRevision: candidate.sourceRevision,
					},
					"catalog",
					timestamp,
					markdown,
				);
				installedIds.add(id);
				return revisionId;
			};

			const revisionId = install(skillId, repositoryId);
			if (!revisionId)
				throw new Error(`Remote skill '${repositoryId}/${skillId}' was not installed`);
			return revisionId;
		},
		remove(skillId: string): boolean {
			const current = db.select().from(skills).where(eq(skills.id, skillId)).get();
			if (!current?.activeRevisionId || current.registrationKind !== "catalog") return false;
			db.update(skills)
				.set({ activeRevisionId: null, updatedAt: now() })
				.where(eq(skills.id, skillId))
				.run();
			return true;
		},
		catalog() {
			return catalogView(db);
		},
		getCatalogDetail(repositoryId: string, skillId: string): SkillCatalogDetail | null {
			const item = catalogView(db).availableSkills.find(
				(candidate) => candidate.repositoryId === repositoryId && candidate.id === skillId,
			);
			if (!item) return null;
			const candidate = db
				.select({
					bytes: skillCatalogEntries.bundleBytes,
					digest: skillCatalogEntries.bundleDigest,
				})
				.from(skillCatalogEntries)
				.where(
					and(
						eq(skillCatalogEntries.repositoryId, repositoryId),
						eq(skillCatalogEntries.skillId, skillId),
					),
				)
				.get();
			if (!candidate) return null;
			return {
				...item,
				skillMarkdown: skillMarkdown(skillId, candidate.bytes, candidate.digest),
				processes: processUsage(db, skillId),
			};
		},
		getInstalledDetail(skillId: string): InstalledSkillCatalogDetail | null {
			const item = catalogView(db).installedSkills.find((candidate) => candidate.id === skillId);
			if (!item) return null;
			const revision = db
				.select({ bytes: skillRevisions.bundleBytes, digest: skillRevisions.bundleDigest })
				.from(skillRevisions)
				.where(eq(skillRevisions.id, item.activeRevisionId))
				.get();
			if (!revision) return null;
			const revisions = db
				.select({
					id: skillRevisions.id,
					sourceRevision: skillRevisions.sourceRevision,
					importedAt: skillRevisions.importedAt,
				})
				.from(skillRevisions)
				.where(eq(skillRevisions.skillId, skillId))
				.all()
				.map((candidate) => ({
					...candidate,
					active: candidate.id === item.activeRevisionId,
				}))
				.sort((left, right) => right.importedAt.localeCompare(left.importedAt));
			return {
				...item,
				skillMarkdown: skillMarkdown(skillId, revision.bytes, revision.digest),
				processes: processUsage(db, skillId),
				revisions,
			};
		},
		recordInvocations(input: {
			instanceId: string;
			turnRecordId: string;
			invocations: readonly { skillId: string; invokedAt: string }[];
		}): void {
			const selections = db
				.select()
				.from(processSkills)
				.where(eq(processSkills.instanceId, input.instanceId))
				.all();
			const uniqueInvocations = new Map(
				input.invocations.map((invocation) => [invocation.skillId, invocation]),
			);
			for (const invocation of uniqueInvocations.values()) {
				const selection = selections.find((row) => row.skillId === invocation.skillId);
				if (!selection) continue;
				db.insert(skillInvocations)
					.values({
						instanceId: input.instanceId,
						turnRecordId: input.turnRecordId,
						skillId: invocation.skillId,
						skillRevisionId: selection.skillRevisionId,
						invokedAt: invocation.invokedAt,
					})
					.onConflictDoNothing()
					.run();
			}
		},
	};
}

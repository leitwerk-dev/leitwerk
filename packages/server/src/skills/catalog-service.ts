import type {
	InstalledSkillCatalogDetail,
	SkillCatalogDetail,
	SkillRepositorySummary,
	SkillsCatalogResponseBody,
} from "@leitwerk-dev/protocol";
import type { SkillRepositoryConfig } from "../config/config-types.js";
import type { RepositoryBundle } from "../db/repositories.js";
import { importSkillRepository } from "./source-importer.js";

/** @internal */
export interface SkillCatalogService {
	/** @internal */
	refresh(): Promise<SkillsCatalogResponseBody>;
	/** @internal */
	list(): SkillsCatalogResponseBody;
	/** @internal */
	detail(repositoryId: string, skillId: string): SkillCatalogDetail | null;
	/** @internal */
	installedDetail(skillId: string): InstalledSkillCatalogDetail | null;
	/** @internal */
	register(repositoryId: string, skillId: string): string;
	/** @internal */
	remove(skillId: string): boolean;
}

export function createSkillCatalogService(input: {
	repositories: readonly SkillRepositoryConfig[];
	repos: RepositoryBundle;
	bundledSkills?: readonly InstalledSkillCatalogDetail[];
	importRepository?: typeof importSkillRepository;
}): SkillCatalogService {
	const importRepository = input.importRepository ?? importSkillRepository;
	const bundledSkills = new Map((input.bundledSkills ?? []).map((skill) => [skill.id, skill]));
	for (const skill of input.repos.skills.listAvailable()) {
		if (bundledSkills.has(skill.id)) {
			throw new Error(`Bundled skill '${skill.id}' conflicts with an installed skill`);
		}
	}
	const statuses = new Map<string, { lastRefreshedAt: string | null; error: string | null }>();
	let refreshPromise: Promise<SkillsCatalogResponseBody> | null = null;
	input.repos.transaction((repos) =>
		repos.skills.markUnconfiguredCatalogEntries(
			input.repositories.map((repository) => repository.id),
		),
	);

	const summaries = (): SkillRepositorySummary[] =>
		input.repositories.map((repository) => {
			const status = statuses.get(repository.id);
			return {
				id: repository.id,
				label: repository.label ?? repository.id,
				url: repository.url,
				ref: repository.ref,
				path: repository.path ?? "skills",
				lastRefreshedAt: status?.lastRefreshedAt ?? null,
				error: status?.error ?? null,
			};
		});

	const list = (): SkillsCatalogResponseBody => {
		const catalog = input.repos.skills.catalog();
		return {
			repositories: summaries(),
			availableSkills: catalog.availableSkills.map((skill) =>
				bundledSkills.has(skill.id)
					? { ...skill, conflict: !skill.stale, registered: false, updateAvailable: false }
					: skill,
			),
			installedSkills: [
				...catalog.installedSkills,
				...[...bundledSkills.values()].map(
					({ skillMarkdown, processes, revisions, ...skill }) => skill,
				),
			].sort(
				(left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
			),
		};
	};

	const refresh = (): Promise<SkillsCatalogResponseBody> => {
		if (refreshPromise) return refreshPromise;
		refreshPromise = (async () => {
			for (const repository of input.repositories) {
				try {
					const imported = await importRepository(repository);
					input.repos.transaction((repos) =>
						repos.skills.mergeCatalog(repository.id, imported.skills),
					);
					statuses.set(repository.id, {
						lastRefreshedAt: new Date().toISOString(),
						error: null,
					});
				} catch (error) {
					statuses.set(repository.id, {
						lastRefreshedAt: statuses.get(repository.id)?.lastRefreshedAt ?? null,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return list();
		})().finally(() => {
			refreshPromise = null;
		});
		return refreshPromise;
	};

	return {
		list,
		refresh,
		detail(repositoryId, skillId) {
			const detail = input.repos.skills.getCatalogDetail(repositoryId, skillId);
			return detail && bundledSkills.has(skillId)
				? { ...detail, conflict: !detail.stale, registered: false, updateAvailable: false }
				: detail;
		},
		installedDetail(skillId) {
			return bundledSkills.get(skillId) ?? input.repos.skills.getInstalledDetail(skillId);
		},
		register(repositoryId, skillId) {
			if (bundledSkills.has(skillId)) {
				throw new Error(`Skill '${skillId}' has a conflicting bundled extension skill`);
			}
			return input.repos.transaction((repos) =>
				repos.skills.registerCatalogEntry(repositoryId, skillId),
			);
		},
		remove(skillId) {
			if (bundledSkills.has(skillId)) return false;
			return input.repos.transaction((repos) => repos.skills.remove(skillId));
		},
	};
}

import type {
	InstalledSkillCatalogDetail,
	SkillCatalogDetail,
	SkillRepositorySummary,
	SkillsCatalogResponseBody,
} from "@leitwerk-dev/protocol";
import type { SkillRepositoryConfig } from "../config/config-types.js";
import type { RepositoryBundle } from "../db/repositories.js";
import { importSkillRepository } from "./source-importer.js";

export interface SkillCatalogService {
	refresh(): Promise<SkillsCatalogResponseBody>;
	list(): SkillsCatalogResponseBody;
	detail(repositoryId: string, skillId: string): SkillCatalogDetail | null;
	installedDetail(skillId: string): InstalledSkillCatalogDetail | null;
	register(repositoryId: string, skillId: string): string;
	remove(skillId: string): boolean;
}

export function createSkillCatalogService(input: {
	repositories: readonly SkillRepositoryConfig[];
	repos: RepositoryBundle;
	importRepository?: typeof importSkillRepository;
}): SkillCatalogService {
	const importRepository = input.importRepository ?? importSkillRepository;
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

	const list = (): SkillsCatalogResponseBody => ({
		repositories: summaries(),
		...input.repos.skills.catalog(),
	});

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
			return input.repos.skills.getCatalogDetail(repositoryId, skillId);
		},
		installedDetail(skillId) {
			return input.repos.skills.getInstalledDetail(skillId);
		},
		register(repositoryId, skillId) {
			return input.repos.transaction((repos) =>
				repos.skills.registerCatalogEntry(repositoryId, skillId),
			);
		},
		remove(skillId) {
			return input.repos.transaction((repos) => repos.skills.remove(skillId));
		},
	};
}

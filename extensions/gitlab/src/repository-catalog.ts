import type { GitLabIntegration } from "./capability.js";
import type { GitLabProject } from "./client.js";

/** Server-owned repository metadata for Settings. @public */
export interface GitLabRepositoryCatalog {
	/** Reuse the last successful scan, loading it once when empty. @public */
	list(profile: string): Promise<readonly GitLabProject[]>;
	/** Search a cached scan or one remote page; repeated queries share cached results. @public */
	search(profile: string, query: string): Promise<readonly GitLabProject[]>;
	/** Read known metadata without making a remote request. @public */
	peek(profile: string, projectId: number): GitLabProject | undefined;
	/** Replace the catalog only after a complete successful scan. @public */
	refresh(profile: string): Promise<readonly GitLabProject[]>;
}

/** @internal */
export function createGitLabRepositoryCatalog(
	integration: GitLabIntegration,
): GitLabRepositoryCatalog {
	const profiles = new Map<
		string,
		{
			origin: string;
			projects?: readonly GitLabProject[];
			pending?: Promise<readonly GitLabProject[]>;
			known: Map<number, GitLabProject>;
			searches: Map<
				string,
				{ projects?: readonly GitLabProject[]; pending?: Promise<readonly GitLabProject[]> }
			>;
		}
	>();
	function entry(profile: string) {
		const client = integration.client(profile);
		let cached = profiles.get(profile);
		if (!cached || cached.origin !== client.baseUrl) {
			cached = { origin: client.baseUrl, known: new Map(), searches: new Map() };
			profiles.set(profile, cached);
		}
		return { client, cached };
	}
	async function refresh(profile: string) {
		const { client, cached } = entry(profile);
		if (cached.pending) return cached.pending;
		const scan = Promise.resolve()
			.then(() => client.listProjects())
			.then((projects) => {
				cached.projects = structuredClone(projects);
				cached.searches.clear();
				cached.known.clear();
				return cached.projects;
			});
		cached.pending = scan;
		try {
			return await scan;
		} finally {
			cached.pending = undefined;
		}
	}
	return {
		async search(profile, text) {
			const query = text.trim().toLowerCase();
			if (query.length < 2) return [];
			const { client, cached } = entry(profile);
			if (cached.projects)
				return cached.projects
					.filter((project) => project.path_with_namespace.toLowerCase().includes(query))
					.slice(0, 100);
			let result = cached.searches.get(query);
			if (!result) {
				result = {};
				cached.searches.set(query, result);
			}
			if (result.projects) return result.projects;
			if (result.pending) return result.pending;
			const scan = Promise.resolve()
				.then(() => client.searchProjects(query))
				.then((projects) => {
					const snapshot = structuredClone(projects);
					result.projects = snapshot;
					if (cached.searches.get(query) === result)
						for (const project of snapshot) cached.known.set(project.id, project);
					return snapshot;
				});
			result.pending = scan;
			try {
				return await scan;
			} finally {
				result.pending = undefined;
			}
		},
		peek(profile, projectId) {
			const { cached } = entry(profile);
			return cached.projects
				? cached.projects.find((project) => project.id === projectId)
				: cached.known.get(projectId);
		},
		async list(profile) {
			return entry(profile).cached.projects ?? refresh(profile);
		},
		refresh,
	};
}

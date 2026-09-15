import type { GitLabClientLike, GitLabProject } from "./client.js";
export interface GitLabSelection {
	projects: { include: readonly string[]; exclude: readonly string[] };
	groups: { include: readonly string[]; exclude: readonly string[] };
	allAccessible: boolean;
}
export function parseGitLabSelection(raw: Record<string, unknown>): GitLabSelection {
	const list = (value: unknown): string[] => {
		if (value === undefined) return [];
		if (
			!Array.isArray(value) ||
			value.some(
				(v) =>
					typeof v !== "string" ||
					!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(v) ||
					v.split("/").some((p: string) => p === "." || p === ".."),
			)
		)
			throw new Error("GitLab selectors require exact namespace paths");
		return [...new Set(value as string[])];
	};
	const pair = (value: unknown) => {
		if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
			throw new Error("GitLab selectors must be objects");
		const item = value as Record<string, unknown> | undefined;
		return { include: list(item?.include), exclude: list(item?.exclude) };
	};
	if (raw.all_accessible !== undefined && typeof raw.all_accessible !== "boolean")
		throw new Error("all_accessible must be a boolean");
	const parsed = {
		projects: pair(raw.projects),
		groups: pair(raw.groups),
		allAccessible: raw.all_accessible === true,
	};
	if (!parsed.allAccessible && !parsed.projects.include.length && !parsed.groups.include.length)
		throw new Error("GitLab requires explicit project/group includes or all_accessible: true");
	return parsed;
}
export function projectExcluded(selection: GitLabSelection, name: string): boolean {
	return (
		selection.projects.exclude.includes(name) ||
		selection.groups.exclude.some((group) => name.startsWith(`${group}/`))
	);
}
/** Include union, subgroup expansion, exclusion precedence, stable-ID deduplication. */
export async function selectGitLabProjects(
	client: GitLabClientLike,
	selection: GitLabSelection,
): Promise<GitLabProject[]> {
	const candidates: GitLabProject[] = selection.allAccessible ? await client.listProjects() : [];
	for (const name of selection.projects.include) candidates.push(await client.getProject(name));
	for (const group of selection.groups.include)
		candidates.push(...(await client.listGroupProjects(group)));
	return [
		...new Map(
			candidates
				.filter((p) => !p.archived && !projectExcluded(selection, p.path_with_namespace))
				.map((p) => [p.id, p]),
		).values(),
	];
}

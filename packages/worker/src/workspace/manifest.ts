import * as v from "valibot";

export interface ComponentManifest {
	version: 1;
	instanceId: string;
	createdAt: string;
	components: ComponentManifestEntry[];
}

export interface ComponentManifestEntry {
	key: string;
	repoLocator: string;
	baseBranch: string;
	workBranch: string;
	clonedAt: string;
	headSha: string;
}

export interface ManifestDiff {
	stale: string[];
	missing: string[];
	extra: string[];
	unchanged: string[];
}

export function serializeManifest(manifest: ComponentManifest): string {
	return JSON.stringify(manifest, null, 2);
}

const jsonObjectSchema = v.custom<Record<string, unknown>>(
	(value): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value),
	"Expected object",
);

const componentManifestEntrySchema = v.pipe(
	jsonObjectSchema,
	v.object({
		key: v.string(),
		repoLocator: v.string(),
		baseBranch: v.string(),
		workBranch: v.string(),
		clonedAt: v.string(),
		headSha: v.string(),
	}),
);

const componentManifestSchema = v.pipe(
	jsonObjectSchema,
	v.object({
		version: v.literal(1),
		instanceId: v.pipe(v.string(), v.minLength(1)),
		createdAt: v.pipe(v.string(), v.minLength(1)),
		components: v.array(componentManifestEntrySchema),
	}),
);

const componentManifestJsonSchema = v.pipe(v.string(), v.parseJson(), componentManifestSchema);

function formatManifestValidationError(issues: readonly v.BaseIssue<unknown>[]): string {
	const issue = issues[0];
	if (issue?.type === "parse_json") return "Invalid JSON";
	const path = issue ? v.getDotPath(issue) : null;
	if (!path) return "Manifest must be a JSON object";
	if (path === "version") return "Unsupported manifest version";
	if (path === "instanceId") return "Invalid instanceId";
	if (path === "createdAt") return "Invalid createdAt";
	if (path === "components") return "components must be an array";
	if (path.match(/^components\.\d+$/)) return "Invalid component entry";
	const componentField = path.match(/^components\.\d+\.([^.]*)$/)?.[1];
	if (componentField) return `Invalid component field: ${componentField}`;
	return issue?.message ? `Invalid manifest: ${issue.message}` : "Invalid manifest";
}

export function deserializeManifest(
	content: string,
): { ok: true; manifest: ComponentManifest } | { ok: false; error: string } {
	const result = v.safeParse(componentManifestJsonSchema, content, { abortEarly: true });
	if (!result.success) {
		return { ok: false, error: formatManifestValidationError(result.issues) };
	}
	return { ok: true, manifest: result.output };
}

export function diffManifest(
	existing: ComponentManifest,
	serverProjects: Array<{
		key: string;
		repoLocator: string;
		baseBranch: string;
		workBranch: string;
	}>,
): ManifestDiff {
	const stale: string[] = [];
	const missing: string[] = [];
	const extra: string[] = [];
	const unchanged: string[] = [];

	const byKey = new Map(existing.components.map((c) => [c.key, c]));
	const serverByKey = new Map(serverProjects.map((p) => [p.key, p]));

	for (const p of serverProjects) {
		const m = byKey.get(p.key);
		if (!m) {
			missing.push(p.key);
			continue;
		}
		if (
			m.repoLocator === p.repoLocator &&
			m.baseBranch === p.baseBranch &&
			m.workBranch === p.workBranch
		) {
			unchanged.push(p.key);
		} else {
			stale.push(p.key);
		}
	}

	for (const c of existing.components) {
		if (!serverByKey.has(c.key)) {
			extra.push(c.key);
		}
	}

	return { stale, missing, extra, unchanged };
}

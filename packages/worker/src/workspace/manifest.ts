import * as v from "valibot";

export interface ComponentManifest {
	version: 1;
	instanceId: string;
	createdAt: string;
	components: ComponentManifestEntry[];
}

export interface ComponentCheckoutPlan {
	key: string;
	repoLocator: string;
	baseBranch: string;
	workBranch: string;
}

export interface ComponentManifestEntry extends ComponentCheckoutPlan {
	clonedAt: string;
	headSha: string;
	/** Exact read-only checkout requested by a process preparation. */
	revision?: string;
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
		revision: v.optional(v.string()),
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

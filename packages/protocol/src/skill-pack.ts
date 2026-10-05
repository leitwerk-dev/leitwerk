import * as v from "valibot";

const nonEmpty = v.pipe(v.string(), v.minLength(1));
const skillId = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,62}$/));
const relativePath = v.pipe(
	v.string(),
	v.check(
		(value) =>
			value.length > 0 &&
			!value.includes("\\") &&
			!value.includes("\0") &&
			value
				.split("/")
				.every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git"),
	),
);

const upstreamSchema = v.object({
	url: nonEmpty,
	commit: v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
});

const entrySchema = v.object({
	id: skillId,
	directory: relativePath,
	label: nonEmpty,
	description: nonEmpty,
	sourcePath: relativePath,
	dependencies: v.array(skillId),
});

const manifestSchema = v.object({
	formatVersion: v.literal(1),
	upstream: upstreamSchema,
	patchDigest: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
	skills: v.pipe(v.array(entrySchema), v.minLength(1)),
});

/** On-disk contract for an extension's generated skill pack. @public */
export interface SkillPackManifest {
	/** @public */
	formatVersion: 1;
	/** @public */
	upstream: {
		/** @public */
		url: string;
		/** @public */
		commit: string;
	};
	/** @public */
	patchDigest: string;
	/** @public */
	skills: {
		/** @public */
		id: string;
		/** @public */
		directory: string;
		/** @public */
		label: string;
		/** @public */
		description: string;
		/** @public */
		sourcePath: string;
		/** @public */
		dependencies: string[];
	}[];
}

/** Provenance retained with an immutable installed skill revision. @internal */
export interface SkillRevisionProvenance {
	/** @internal */
	extensionId: string;
	/** @internal */
	packageName: string;
	/** @internal */
	packageVersion: string;
	/** @internal */
	upstream: SkillPackManifest["upstream"];
	/** @internal */
	sourcePath: string;
	/** @internal */
	patchDigest: string;
	/** @internal */
	dependencies: string[];
}

/** Validates pack-local dependencies as well as the manifest shape. @internal */
export function parseSkillPackManifest(input: unknown): SkillPackManifest {
	const manifest = v.parse(manifestSchema, input);
	const byId = new Map(manifest.skills.map((skill) => [skill.id, skill]));
	if (byId.size !== manifest.skills.length) throw new Error("Duplicate skill ID in skill pack");
	const directories = new Set(manifest.skills.map((skill) => skill.directory));
	if (directories.size !== manifest.skills.length) throw new Error("Duplicate skill directory");
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (id: string): void => {
		if (visited.has(id)) return;
		if (visiting.has(id)) throw new Error(`Circular skill dependency at '${id}'`);
		const entry = byId.get(id);
		if (!entry) throw new Error(`Missing skill pack dependency '${id}'`);
		if (new Set(entry.dependencies).size !== entry.dependencies.length) {
			throw new Error(`Duplicate dependencies for skill '${id}'`);
		}
		visiting.add(id);
		for (const dependency of entry.dependencies) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of byId.keys()) visit(id);
	return manifest;
}

import * as v from "valibot";
import { validateResourceRelativePath } from "./pi-resource-bundle.js";

export const PI_RESOURCE_SNAPSHOT_SCHEMA_VERSION = 1;

const nonBlankStringSchema = v.pipe(
	v.string(),
	v.check((value) => value.trim() !== "", "Expected a non-empty string"),
);
const jsonObjectSchema = v.record(v.string(), v.unknown());
const positiveSafeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const nonNegativeSafeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const piResourceManifestSchema = v.strictObject({
	schemaVersion: v.literal(PI_RESOURCE_SNAPSHOT_SCHEMA_VERSION),
	model: v.strictObject({
		profileId: nonBlankStringSchema,
		providerId: nonBlankStringSchema,
		modelId: nonBlankStringSchema,
		thinkingLevel: nonBlankStringSchema,
	}),
	providerOptions: v.record(v.string(), nonBlankStringSchema),
	providerWorkerConfig: v.nullable(
		v.strictObject({
			version: positiveSafeIntegerSchema,
			value: jsonObjectSchema,
		}),
	),
	declaredCredentialPaths: v.array(nonBlankStringSchema),
	compatibility: v.strictObject({
		workerApiVersion: nonBlankStringSchema,
		piVersion: nonBlankStringSchema,
		protocolVersion: v.optional(nonBlankStringSchema),
	}),
	provenance: v.array(
		v.strictObject({
			kind: v.picklist(["extension", "skill", "prompt", "generated"]),
			ownerExtensionId: v.nullable(nonBlankStringSchema),
			packageName: v.nullable(nonBlankStringSchema),
			snapshotPath: nonBlankStringSchema,
			sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
			size: nonNegativeSafeIntegerSchema,
		}),
	),
});

type DeepReadonly<T> = T extends readonly unknown[]
	? { readonly [Index in keyof T]: DeepReadonly<T[Index]> }
	: T extends object
		? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
		: T;

export type PiResourceManifest = DeepReadonly<v.InferOutput<typeof piResourceManifestSchema>>;
export type PiResourceSnapshotModel = PiResourceManifest["model"];
export type PiResourceSnapshotWorkerConfig = NonNullable<
	PiResourceManifest["providerWorkerConfig"]
>;
export type PiResourceSnapshotCompatibility = PiResourceManifest["compatibility"];
export type PiResourceFileProvenance = PiResourceManifest["provenance"][number];
export type PiResourceProvenanceKind = PiResourceFileProvenance["kind"];

function invalidManifest(message: string, cause?: unknown): never {
	throw new Error(`Invalid managed Pi resource snapshot: ${message}`, { cause });
}

/** Parses and validates the complete generated.json contract. */
export function parsePiResourceManifest(raw: unknown): PiResourceManifest {
	let manifest: PiResourceManifest;
	try {
		manifest = v.parse(piResourceManifestSchema, raw);
	} catch (error) {
		invalidManifest("generated.json does not match the resource manifest schema", error);
	}

	let declaredCredentialPaths: string[];
	let provenance: PiResourceFileProvenance[];
	try {
		declaredCredentialPaths = manifest.declaredCredentialPaths.map(validateResourceRelativePath);
		provenance = manifest.provenance.map((item) => ({
			...item,
			snapshotPath: validateResourceRelativePath(item.snapshotPath),
		}));
	} catch (error) {
		invalidManifest("generated.json contains an unsafe path", error);
	}
	if (new Set(declaredCredentialPaths).size !== declaredCredentialPaths.length) {
		invalidManifest("generated.json declares a credential path more than once");
	}
	const provenancePaths = provenance.map((item) => item.snapshotPath);
	if (new Set(provenancePaths).size !== provenancePaths.length) {
		invalidManifest("generated.json contains duplicate provenance paths");
	}
	for (const credentialPath of declaredCredentialPaths) {
		if (credentialPath === "generated.json" || provenancePaths.includes(credentialPath)) {
			invalidManifest(`credential path '${credentialPath}' overlaps immutable snapshot content`);
		}
	}
	return { ...manifest, declaredCredentialPaths, provenance };
}

type JsonRecord = Record<string, unknown>;

export function canonicalizeJson(value: unknown, location = "value"): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${location} contains a non-finite number`);
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) {
		return value.map((item, index) => canonicalizeJson(item, `${location}[${index}]`));
	}
	if (typeof value !== "object") throw new Error(`${location} contains a non-JSON value`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${location} contains a non-plain object`);
	}
	return Object.fromEntries(
		Object.keys(value as JsonRecord)
			.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
			.map((key) => [key, canonicalizeJson((value as JsonRecord)[key], `${location}.${key}`)]),
	);
}

export function canonicalJsonStringify(value: unknown, location = "value"): string {
	return JSON.stringify(canonicalizeJson(value, location));
}

export function canonicalJsonEqual(left: unknown, right: unknown): boolean {
	return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

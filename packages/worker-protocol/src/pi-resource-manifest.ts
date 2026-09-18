import * as v from "valibot";
import { validateResourceRelativePath } from "./pi-resource-bundle.js";

/** @internal */
export const PI_RESOURCE_SNAPSHOT_SCHEMA_VERSION = 1;

const nonBlankStringSchema = v.pipe(
	v.string(),
	v.check((value) => value.trim() !== "", "Expected a non-empty string"),
);
const jsonObjectSchema = v.record(v.string(), v.unknown());
const positiveSafeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const nonNegativeSafeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** @internal */
export const piResourceManifestSchema = v.strictObject({
	/** @internal */
	schemaVersion: v.literal(PI_RESOURCE_SNAPSHOT_SCHEMA_VERSION),
	/** @internal */
	model: v.strictObject({
		/** @internal */
		profileId: nonBlankStringSchema,
		/** @internal */
		providerId: nonBlankStringSchema,
		/** @internal */
		modelId: nonBlankStringSchema,
		/** @internal */
		thinkingLevel: nonBlankStringSchema,
	}),
	/** @internal */
	providerOptions: v.record(v.string(), nonBlankStringSchema),
	/** @internal */
	providerWorkerConfig: v.nullable(
		v.strictObject({
			/** @internal */
			version: positiveSafeIntegerSchema,
			/** @internal */
			value: jsonObjectSchema,
		}),
	),
	/** @internal */
	declaredCredentialPaths: v.array(nonBlankStringSchema),
	/** @internal */
	compatibility: v.strictObject({
		/** @internal */
		workerApiVersion: nonBlankStringSchema,
		/** @internal */
		piVersion: nonBlankStringSchema,
		/** @internal */
		protocolVersion: v.optional(nonBlankStringSchema),
	}),
	/** @internal */
	provenance: v.array(
		v.strictObject({
			/** @internal */
			kind: v.picklist(["extension", "skill", "prompt", "generated"]),
			/** @internal */
			ownerExtensionId: v.nullable(nonBlankStringSchema),
			/** @internal */
			packageName: v.nullable(nonBlankStringSchema),
			/** @internal */
			snapshotPath: nonBlankStringSchema,
			/** @internal */
			sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
			/** @internal */
			size: nonNegativeSafeIntegerSchema,
		}),
	),
});

/** @internal */
type DeepReadonly<T> = T extends readonly unknown[]
	? { readonly [Index in keyof T]: DeepReadonly<T[Index]> }
	: T extends object
		? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
		: T;

/** @internal */
export type PiResourceManifest = DeepReadonly<v.InferOutput<typeof piResourceManifestSchema>>;
/** @internal */
export type PiResourceSnapshotModel = PiResourceManifest["model"];
/** @internal */
export type PiResourceSnapshotWorkerConfig = NonNullable<
	PiResourceManifest["providerWorkerConfig"]
>;
/** @internal */
export type PiResourceSnapshotCompatibility = PiResourceManifest["compatibility"];
/** @internal */
export type PiResourceFileProvenance = PiResourceManifest["provenance"][number];
/** @internal */
export type PiResourceProvenanceKind = PiResourceFileProvenance["kind"];

function invalidManifest(message: string, cause?: unknown): never {
	throw new Error(`Invalid managed Pi resource snapshot: ${message}`, { cause });
}

/** Parses and validates the complete generated.json contract. @internal */
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

/** @internal */
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

/** @internal */
export function canonicalJsonStringify(value: unknown, location = "value"): string {
	return JSON.stringify(canonicalizeJson(value, location));
}

/** @internal */
export function canonicalJsonEqual(left: unknown, right: unknown): boolean {
	return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

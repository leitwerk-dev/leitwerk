import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { CatalogPiContribution } from "@leitwerk-dev/extension-runtime";
import {
	canonicalizeJson,
	canonicalJsonStringify,
	createCanonicalPiResourceBundle,
	PI_RESOURCE_SNAPSHOT_SCHEMA_VERSION,
	type PiResourceBundle,
	type PiResourceManifest,
	type PiResourceSnapshotCompatibility,
	type PiResourceSnapshotModel,
	type PiResourceSnapshotWorkerConfig,
	sha256Digest,
	validateResourceRelativePath,
} from "@leitwerk-dev/worker-protocol";
import { build } from "esbuild";
import {
	compareResourcePaths,
	type PiResourceLayer,
	type PiResourceLimits,
	ResourceCollector,
} from "./resource-collector.js";

export {
	PI_RESOURCE_SNAPSHOT_SCHEMA_VERSION,
	type PiResourceFileProvenance,
	type PiResourceProvenanceKind,
	type PiResourceSnapshotCompatibility,
	type PiResourceSnapshotModel,
	type PiResourceSnapshotWorkerConfig,
} from "@leitwerk-dev/worker-protocol";

type JsonObject = Record<string, unknown>;

export type PiResourceAssemblyLimits = PiResourceLimits;

export interface AssemblePiResourceSnapshotInput {
	/** Immutable resource fragments pinned to the process. */
	readonly resourceLayers?: readonly PiResourceLayer[];
	/** Catalog dependency order is preserved in generated numeric extension paths. */
	readonly piContributions: readonly CatalogPiContribution[];
	readonly model: PiResourceSnapshotModel;
	readonly providerOptions: Readonly<Record<string, string>>;
	readonly providerWorkerConfig: PiResourceSnapshotWorkerConfig | null;
	readonly piSettings: JsonObject;
	/** Non-secret Pi model definitions and overrides. Defaults to an empty provider map. */
	readonly piModels?: JsonObject;
	readonly declaredCredentialPaths: readonly string[];
	readonly compatibility: PiResourceSnapshotCompatibility;
	readonly systemPrompt?: string | null;
	readonly appendSystemPrompt?: string | null;
	readonly limits?: PiResourceAssemblyLimits;
}

export type PiResourceGeneratedMetadata = PiResourceManifest;

export interface AssembledPiResourceSnapshot {
	readonly bundle: PiResourceBundle;
	readonly generated: PiResourceGeneratedMetadata;
	readonly files: readonly {
		readonly path: string;
		readonly sha256: string;
		readonly size: number;
	}[];
}

function jsonBytes(value: unknown, location: string): Uint8Array {
	return Buffer.from(`${canonicalJsonStringify(value, location)}\n`, "utf8");
}

const FORBIDDEN_SECRET_KEYS = new Set([
	"apikey",
	"accesstoken",
	"refreshtoken",
	"brokertoken",
	"clientsecret",
	"privatekey",
	"password",
	"secret",
	"authorization",
]);

function assertNoCredentialFields(value: unknown, location: string): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			assertNoCredentialFields(item, `${location}[${index}]`);
		});
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, nested] of Object.entries(value)) {
		const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
		if (FORBIDDEN_SECRET_KEYS.has(normalizedKey)) {
			throw new Error(
				`${location}.${key} is credential-bearing and cannot enter a Pi resource snapshot`,
			);
		}
		assertNoCredentialFields(nested, `${location}.${key}`);
	}
}

function safeExtensionSegment(ownerExtensionId: string): string {
	const normalized =
		ownerExtensionId
			.normalize("NFKD")
			.replaceAll(/[^A-Za-z0-9._-]+/g, "-")
			.replaceAll(/^-+|-+$/g, "") || "extension";
	if (Buffer.byteLength(normalized, "utf8") <= 56) return normalized;
	return `${normalized.slice(0, 43)}-${sha256Digest(Buffer.from(ownerExtensionId)).slice(0, 12)}`;
}

function extensionSnapshotPath(contribution: CatalogPiContribution, index: number): string {
	const prefix = String(index * 10).padStart(3, "0");
	return validateResourceRelativePath(
		`extensions/${prefix}-${safeExtensionSegment(contribution.ownerExtensionId)}.js`,
	);
}

const PI_CORE_EXTERNALS = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"];

/**
 * Builds a normal Pi extension around a Leitwerk contribution. The contribution is
 * bundled so its relative imports survive snapshot materialization; Pi itself stays
 * external so it is shared with the worker image.
 */
async function buildPiExtensionWrapper(entryPath: string): Promise<Uint8Array> {
	const result = await build({
		absWorkingDir: path.dirname(entryPath),
		bundle: true,
		stdin: {
			contents: `
import contribution from ${JSON.stringify(entryPath)};
import { readFileSync } from "node:fs";

function readGenerated() {
  return JSON.parse(readFileSync(new URL("../generated.json", import.meta.url), "utf8"));
}

function credentialBag(generated) {
  let values;
  const load = () => {
    if (values) return values;
    values = {};
    for (const credentialPath of generated.declaredCredentialPaths) {
      if (typeof credentialPath !== "string" || credentialPath.startsWith("/") || credentialPath.includes("..") || credentialPath.includes("\\\\")) {
        throw new Error("Invalid declared Pi credential path");
      }
      const credential = JSON.parse(readFileSync(new URL("../" + credentialPath, import.meta.url), "utf8"));
      if (credential && typeof credential === "object" && !Array.isArray(credential)) Object.assign(values, credential);
    }
    return values;
  };
  return {
    get(key) { const value = load()[key]; return typeof value === "string" ? value : undefined; },
    require(key) { const value = this.get(key); if (value === undefined) throw new Error("Required Pi worker secret '" + key + "' is unavailable"); return value; },
    keys() { return Object.keys(load()).filter((key) => typeof load()[key] === "string").sort(); },
  };
}

export default async function leitwerkPiExtension(pi) {
  if (typeof contribution !== "function") throw new Error("Leitwerk Pi worker entry must default-export a function");
  const generated = readGenerated();
  const workerConfig = generated.providerWorkerConfig === null ? null : generated.providerWorkerConfig?.value;
  const report = (event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Pi worker report must be an object");
    pi.events?.emit?.("leitwerk:provider-report", event);
  };
  await contribution(pi, {
    model: { providerId: generated.model.providerId, modelId: generated.model.modelId },
    options: { ...generated.providerOptions },
    workerConfig,
    secrets: credentialBag(generated),
    report,
  });
}
`,
			resolveDir: path.dirname(entryPath),
			sourcefile: "leitwerk-pi-wrapper.js",
		},
		format: "esm",
		platform: "node",
		target: "node22",
		write: false,
		minify: true,
		sourcemap: false,
		legalComments: "none",
		external: PI_CORE_EXTERNALS,
	});
	const output = result.outputFiles[0];
	if (!output) throw new Error(`Pi extension wrapper did not produce output for '${entryPath}'`);
	return output.contents;
}

function validatePhysicalSourcePath(sourcePath: string): void {
	if (!path.isAbsolute(sourcePath) || path.normalize(sourcePath) !== sourcePath) {
		throw new Error(`Pi resource source path must be normalized and absolute: ${sourcePath}`);
	}
}

function normalizeCredentialPaths(paths: readonly string[]): readonly string[] {
	const seen = new Set<string>();
	const normalized = paths.map((credentialPath) => {
		const result = validateResourceRelativePath(credentialPath);
		if (seen.has(result)) throw new Error(`Duplicate declared credential path '${result}'`);
		seen.add(result);
		return result;
	});
	return normalized.sort(compareResourcePaths);
}

function assertCredentialPathsDoNotOverlap(
	credentialPaths: readonly string[],
	immutablePaths: Iterable<string>,
): void {
	const files = [...immutablePaths];
	for (const credentialPath of credentialPaths) {
		for (const immutablePath of files) {
			if (
				credentialPath === immutablePath ||
				credentialPath.startsWith(`${immutablePath}/`) ||
				immutablePath.startsWith(`${credentialPath}/`)
			) {
				throw new Error(
					`Declared credential path '${credentialPath}' overlaps immutable resource '${immutablePath}'`,
				);
			}
		}
	}
}

function requireNonEmptyString(value: unknown, location: string): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${location} must be a non-empty string`);
	}
}

function validateAssemblyInput(input: AssemblePiResourceSnapshotInput): void {
	requireNonEmptyString(input.model.profileId, "model.profileId");
	requireNonEmptyString(input.model.providerId, "model.providerId");
	requireNonEmptyString(input.model.modelId, "model.modelId");
	requireNonEmptyString(input.model.thinkingLevel, "model.thinkingLevel");
	requireNonEmptyString(input.compatibility.workerApiVersion, "compatibility.workerApiVersion");
	requireNonEmptyString(input.compatibility.piVersion, "compatibility.piVersion");
	if (input.compatibility.protocolVersion !== undefined) {
		requireNonEmptyString(input.compatibility.protocolVersion, "compatibility.protocolVersion");
	}
	for (const [fieldId, value] of Object.entries(input.providerOptions)) {
		if (fieldId.trim() === "" || typeof value !== "string") {
			throw new Error("providerOptions must contain non-empty field ids and string values");
		}
	}
	if (
		input.providerWorkerConfig &&
		(!Number.isSafeInteger(input.providerWorkerConfig.version) ||
			input.providerWorkerConfig.version < 1)
	) {
		throw new Error("providerWorkerConfig.version must be a positive safe integer");
	}
	if (input.systemPrompt !== undefined && input.systemPrompt !== null) {
		if (typeof input.systemPrompt !== "string") throw new Error("systemPrompt must be a string");
	}
	if (input.appendSystemPrompt !== undefined && input.appendSystemPrompt !== null) {
		if (typeof input.appendSystemPrompt !== "string") {
			throw new Error("appendSystemPrompt must be a string");
		}
	}
}

/** Assemble one immutable, non-secret, canonical Pi resource snapshot. */
export async function assemblePiResourceSnapshot(
	input: AssemblePiResourceSnapshotInput,
): Promise<AssembledPiResourceSnapshot> {
	validateAssemblyInput(input);
	assertNoCredentialFields(input.piSettings, "piSettings");
	assertNoCredentialFields(input.piModels ?? {}, "piModels");
	assertNoCredentialFields(input.providerOptions, "providerOptions");
	assertNoCredentialFields(input.providerWorkerConfig?.value ?? {}, "providerWorkerConfig.value");
	const collector = new ResourceCollector(input.limits);
	const seenOwners = new Set<string>();
	const workerSourceIdentities = new Map<string, string>();
	const workerSourceRealPaths = new Map<string, string>();

	const settings = { ...input.piSettings, packages: [], defaultProjectTrust: "never" };
	collector.addBytes("settings.json", jsonBytes(settings, "settings.json"));
	collector.addBytes("models.json", jsonBytes(input.piModels ?? { providers: {} }, "models.json"));
	if (input.systemPrompt !== undefined && input.systemPrompt !== null) {
		collector.addBytes("SYSTEM.md", Buffer.from(input.systemPrompt, "utf8"));
	}
	if (input.appendSystemPrompt !== undefined && input.appendSystemPrompt !== null) {
		collector.addBytes("APPEND_SYSTEM.md", Buffer.from(input.appendSystemPrompt, "utf8"));
	}

	for (const layer of input.resourceLayers ?? []) collector.addBundle(layer.bundle, layer.owner);

	for (const [index, contribution] of input.piContributions.entries()) {
		if (seenOwners.has(contribution.ownerExtensionId)) {
			throw new Error(
				`Extension '${contribution.ownerExtensionId}' appears more than once in Pi contributions`,
			);
		}
		seenOwners.add(contribution.ownerExtensionId);
		const baseOwner = {
			ownerExtensionId: contribution.ownerExtensionId,
			packageName: contribution.packageName,
		};
		if (contribution.workerEntryPath) {
			validatePhysicalSourcePath(contribution.workerEntryPath);
			const source = await lstat(contribution.workerEntryPath);
			if (source.isSymbolicLink() || !source.isFile()) {
				throw new Error(
					`Pi resource source must be a regular file: ${contribution.workerEntryPath}`,
				);
			}
			const identity = `${source.dev}:${source.ino}`;
			const physicalPath = await realpath(contribution.workerEntryPath);
			const first = workerSourceIdentities.get(identity) ?? workerSourceRealPaths.get(physicalPath);
			if (first) {
				throw new Error(
					`Physical Pi resource file is included more than once: ${contribution.workerEntryPath} (first: ${first})`,
				);
			}
			workerSourceIdentities.set(identity, contribution.workerEntryPath);
			workerSourceRealPaths.set(physicalPath, contribution.workerEntryPath);
			const snapshotPath = extensionSnapshotPath(contribution, index);
			collector.addBytes(
				snapshotPath,
				await buildPiExtensionWrapper(contribution.workerEntryPath),
				{ kind: "extension", ...baseOwner },
			);
		}
		for (const skillDirectory of contribution.resources.skillDirectories) {
			await collector.addDirectory(skillDirectory, "skills", { kind: "skill", ...baseOwner });
		}
		for (const promptDirectory of contribution.resources.promptDirectories) {
			await collector.addDirectory(promptDirectory, "prompts", { kind: "prompt", ...baseOwner });
		}
	}

	const credentialPaths = normalizeCredentialPaths(input.declaredCredentialPaths);
	assertCredentialPathsDoNotOverlap(credentialPaths, [...collector.files.keys(), "generated.json"]);
	const provenance = collector.provenance
		.slice()
		.sort((left, right) => compareResourcePaths(left.snapshotPath, right.snapshotPath));
	const generated = {
		schemaVersion: PI_RESOURCE_SNAPSHOT_SCHEMA_VERSION,
		model: { ...input.model },
		providerOptions: { ...input.providerOptions },
		providerWorkerConfig: input.providerWorkerConfig
			? {
					version: input.providerWorkerConfig.version,
					value: canonicalizeJson(
						input.providerWorkerConfig.value,
						"providerWorkerConfig.value",
					) as JsonObject,
				}
			: null,
		declaredCredentialPaths: credentialPaths,
		compatibility: { ...input.compatibility },
		provenance,
	} satisfies PiResourceGeneratedMetadata;
	collector.addBytes("generated.json", jsonBytes(generated, "generated.json"));

	const resourceFiles = collector.toResourceFiles();
	const bundle = createCanonicalPiResourceBundle(resourceFiles);
	return {
		bundle,
		generated,
		files: resourceFiles.map((file) => ({
			path: file.path,
			sha256: sha256Digest(file.content),
			size: file.content.byteLength,
		})),
	};
}

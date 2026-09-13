import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedTurnStart } from "@leitwerk-dev/domain";
import {
	canonicalJsonEqual,
	IPC_PROTOCOL_VERSION,
	type PiResourceManifest,
	parsePiResourceManifest,
	WORKER_API_VERSION,
	type WorkerCredentialMaterial,
} from "@leitwerk-dev/worker-protocol";
import type { DeclaredCredentialFile } from "./managed-pi-agent-dir.js";

type ResolvedLlmTurnStart = Extract<ResolvedTurnStart, { kind: "llm" }>;

type JsonRecord = Record<string, unknown>;

export type ManagedPiResourceManifest = PiResourceManifest;

function fail(message: string): never {
	throw new Error(`Invalid managed Pi resource snapshot: ${message}`);
}

function record(value: unknown, location: string): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(`${location} must be an object`);
	}
	return value as JsonRecord;
}

function assertJsonEqual(actual: unknown, expected: unknown, location: string): void {
	if (!canonicalJsonEqual(actual, expected)) {
		fail(`${location} does not match the resolved LLM start`);
	}
}

function assertModelMatchesStart(
	manifest: ManagedPiResourceManifest,
	start: ResolvedLlmTurnStart,
): void {
	for (const key of ["profileId", "providerId", "modelId", "thinkingLevel"] as const) {
		if (manifest.model[key] !== start.model[key]) {
			fail(
				`generated.json model ${key} '${manifest.model[key]}' does not match start '${start.model[key]}'`,
			);
		}
	}
}

async function assertCompatibility(manifest: ManagedPiResourceManifest): Promise<void> {
	const { VERSION: PI_VERSION } = await import("@earendil-works/pi-coding-agent");
	if (manifest.compatibility.workerApiVersion !== WORKER_API_VERSION) {
		fail(
			`server snapshot worker API version '${manifest.compatibility.workerApiVersion}' does not match local worker API version '${WORKER_API_VERSION}'`,
		);
	}
	if (manifest.compatibility.piVersion !== PI_VERSION) {
		fail(
			`server snapshot Pi version '${manifest.compatibility.piVersion}' does not match local worker Pi version '${PI_VERSION}'`,
		);
	}
	if (
		manifest.compatibility.protocolVersion !== undefined &&
		manifest.compatibility.protocolVersion !== IPC_PROTOCOL_VERSION
	) {
		fail(
			`server snapshot protocol version '${manifest.compatibility.protocolVersion}' does not match local worker protocol version '${IPC_PROTOCOL_VERSION}'`,
		);
	}
}

export async function readAndValidateManagedPiResourceManifest(input: {
	agentDir: string;
	resourceDigest: string;
	start: ResolvedLlmTurnStart;
}): Promise<ManagedPiResourceManifest> {
	const marker = await readFile(path.join(input.agentDir, ".leitwerk-resource-digest"), "utf8");
	if (marker !== `${input.resourceDigest}\n`) {
		fail("materialized resource digest marker does not match the delivered bundle");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path.join(input.agentDir, "generated.json"), "utf8"));
	} catch (error) {
		throw new Error("Invalid managed Pi resource snapshot: generated.json is unreadable", {
			cause: error,
		});
	}
	const manifest = parsePiResourceManifest(parsed);
	assertModelMatchesStart(manifest, input.start);
	await assertCompatibility(manifest);
	assertJsonEqual(manifest.providerOptions, input.start.providerOptions, "providerOptions");
	assertJsonEqual(
		manifest.providerWorkerConfig,
		input.start.providerWorkerConfig,
		"providerWorkerConfig",
	);
	let settings: unknown;
	try {
		settings = JSON.parse(await readFile(path.join(input.agentDir, "settings.json"), "utf8"));
	} catch (error) {
		throw new Error("Invalid managed Pi resource snapshot: settings.json is unreadable", {
			cause: error,
		});
	}
	assertJsonEqual(
		settings,
		{ ...input.start.piSettings, packages: [], defaultProjectTrust: "never" },
		"settings.json",
	);
	return manifest;
}

export function buildManagedPiCredentialFiles(input: {
	manifest: ManagedPiResourceManifest;
	credential: WorkerCredentialMaterial | null;
	providerId: string;
}): DeclaredCredentialFile[] {
	if (input.credential && input.credential.providerId !== input.providerId) {
		throw new Error(
			`Credential provider '${input.credential.providerId}' does not match selected provider '${input.providerId}'`,
		);
	}
	const values = input.credential?.values ?? {};
	const apiKey = values.apiKey;
	if (apiKey !== undefined && apiKey.trim() === "") {
		throw new Error(`Credential apiKey for provider '${input.providerId}' is empty`);
	}
	let auth: Record<string, unknown> = {};
	if (apiKey) {
		auth = { [input.providerId]: { type: "api_key", key: apiKey } };
	} else if (values.type === "oauth") {
		const entry: Record<string, unknown> = { type: "oauth" };
		for (const key of ["refresh", "access"] as const) {
			if (values[key] !== undefined) entry[key] = values[key];
		}
		if (values.expires !== undefined) {
			const expires = Number(values.expires);
			entry.expires = Number.isNaN(expires) ? values.expires : expires;
		}
		auth = { [input.providerId]: entry };
	}
	if (
		Object.keys(auth).length > 0 &&
		!input.manifest.declaredCredentialPaths.includes("auth.json")
	) {
		throw new Error(
			`Provider '${input.providerId}' standard credential requires declared auth.json`,
		);
	}
	return input.manifest.declaredCredentialPaths.map((credentialPath) => ({
		path: credentialPath,
		content: `${JSON.stringify(credentialPath === "auth.json" ? auth : values, null, 2)}\n`,
	}));
}

export async function assertManagedPiCredentialFiles(input: {
	agentDir: string;
	manifest: ManagedPiResourceManifest;
	credential: WorkerCredentialMaterial | null;
}): Promise<void> {
	for (const credentialPath of input.manifest.declaredCredentialPaths) {
		const target = path.join(input.agentDir, credentialPath);
		const stat = await lstat(target).catch(() => null);
		if (!stat?.isFile() || stat.isSymbolicLink()) {
			throw new Error(`Declared credential file '${credentialPath}' is missing or unsafe`);
		}
		if ((stat.mode & 0o777) !== 0o600) {
			throw new Error(`Declared credential file '${credentialPath}' must have mode 0600`);
		}
	}
	if (input.credential && input.manifest.declaredCredentialPaths.includes("auth.json")) {
		const auth = record(
			JSON.parse(await readFile(path.join(input.agentDir, "auth.json"), "utf8")),
			"auth.json",
		);
		if (input.credential.values.apiKey) {
			const providerCredential = record(
				auth[input.credential.providerId],
				`auth.json.${input.credential.providerId}`,
			);
			if (
				(providerCredential.type !== "api_key" && providerCredential.type !== undefined) ||
				providerCredential.key !== input.credential.values.apiKey
			) {
				throw new Error(
					`Standard Pi credential for provider '${input.credential.providerId}' was not loaded`,
				);
			}
		} else if (input.credential.values.refresh || input.credential.values.access) {
			const providerCredential = record(
				auth[input.credential.providerId],
				`auth.json.${input.credential.providerId}`,
			);
			if (
				providerCredential.type !== "oauth" ||
				(input.credential.values.refresh &&
					providerCredential.refresh !== input.credential.values.refresh) ||
				(input.credential.values.access &&
					providerCredential.access !== input.credential.values.access)
			) {
				throw new Error(
					`Standard Pi OAuth credential for provider '${input.credential.providerId}' was not loaded`,
				);
			}
		}
	}
}

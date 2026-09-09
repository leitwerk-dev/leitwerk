import type {
	createProviderCredentialRepo,
	ProviderCredentialRecord,
} from "../db/provider-credential-repo.js";
import type {
	ModelProviderCredentialStatusResolver,
	ModelProviderRegistry,
	RegisteredModelProvider,
} from "./registry.js";

const MAX_CREDENTIAL_PAYLOAD_BYTES = 64 * 1024;
const MAX_SECRET_FIELDS = 64;
const MAX_SECRET_KEY_LENGTH = 128;
const MAX_SECRET_VALUE_LENGTH = 64 * 1024;

type CredentialRepo = ReturnType<typeof createProviderCredentialRepo>;

export interface ResolvedProviderCredential {
	providerId: string;
	revision: number | null;
	values: Record<string, string>;
}

export interface ProviderCredentialUpdateResult {
	accepted: boolean;
	currentRevision: number | null;
	safeReason?: string;
}

export interface ModelProviderCredentialService {
	initialize(): void;
	status: ModelProviderCredentialStatusResolver;
	resolve(
		providerId: string,
		options?: Readonly<Record<string, string>>,
	): ResolvedProviderCredential | null;
	compareAndSet(input: {
		providerId: string;
		expectedRevision: number;
		value: unknown;
	}): ProviderCredentialUpdateResult;
}

function parseCredential(provider: RegisteredModelProvider, value: unknown): unknown {
	return provider.definition.credential?.parse
		? provider.definition.credential.parse(value)
		: value;
}

function encodeCredential(value: unknown): string {
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch (error) {
		throw new Error("Provider credential is not JSON serializable", { cause: error });
	}
	if (encoded === undefined) throw new Error("Provider credential must be a JSON value");
	if (Buffer.byteLength(encoded, "utf8") > MAX_CREDENTIAL_PAYLOAD_BYTES) {
		throw new Error(`Provider credential exceeds ${MAX_CREDENTIAL_PAYLOAD_BYTES} encoded bytes`);
	}
	return encoded;
}

function decodeCredential(
	provider: RegisteredModelProvider,
	record: ProviderCredentialRecord,
): unknown {
	const definition = provider.definition.credential;
	if (!definition) throw new Error(`Provider '${provider.id}' does not declare credentials`);
	let value: unknown;
	try {
		value = JSON.parse(record.payload);
	} catch (error) {
		throw new Error(`Provider credential payload for '${provider.id}' is not valid JSON`, {
			cause: error,
		});
	}
	return parseCredential(provider, value);
}

function validateSecrets(
	providerId: string,
	value: Readonly<Record<string, string>>,
): Record<string, string> {
	const entries = Object.entries(value);
	if (entries.length > MAX_SECRET_FIELDS) {
		throw new Error(`Provider '${providerId}' returned too many secret fields`);
	}
	const secrets: Record<string, string> = {};
	for (const [key, secret] of entries) {
		if (
			key.length === 0 ||
			key.length > MAX_SECRET_KEY_LENGTH ||
			typeof secret !== "string" ||
			secret.length > MAX_SECRET_VALUE_LENGTH
		) {
			throw new Error(`Provider '${providerId}' returned an invalid secret field`);
		}
		secrets[key] = secret;
	}
	return secrets;
}

function materializeSecrets(
	provider: RegisteredModelProvider,
	credential: unknown,
	options: Readonly<Record<string, string>>,
): Record<string, string> {
	const secrets = provider.definition.secrets({
		config: provider.config,
		credential,
		options,
	});
	if (typeof secrets !== "object" || secrets === null || Array.isArray(secrets)) {
		throw new Error(`Provider '${provider.id}' returned an invalid secret bag`);
	}
	return validateSecrets(provider.id, secrets);
}

/**
 * Owns encrypted provider credential reads, startup seed/rotation, short-lived
 * secret projection, and revision compare-and-set. Secret values never enter
 * model status, receipts, or durable turn records.
 */
export function createModelProviderCredentialService(input: {
	registry: ModelProviderRegistry;
	repo: CredentialRepo;
}): ModelProviderCredentialService {
	const status: ModelProviderCredentialStatusResolver = (provider) => {
		if (!provider.definition.credential) return { available: true, revision: null };
		const record = input.repo.get(provider.id);
		if (!record) return { available: false, revision: null };
		decodeCredential(provider, record);
		return { available: true, revision: record.revision };
	};

	return {
		initialize(): void {
			for (const provider of input.registry.list()) {
				if (!provider.definition.credential) continue;
				const current = input.repo.get(provider.id);
				if (current) decodeCredential(provider, current);
				// Configured credentials only initialize an empty store. Durable state wins
				// thereafter; rotation uses the explicit revision-CAS path.
				if (current || provider.configuredCredential === null) continue;
				const parsed = parseCredential(provider, provider.configuredCredential);
				input.repo.create({
					providerId: provider.id,
					payload: encodeCredential(parsed),
				});
			}
		},
		status,
		resolve(providerId, options = {}): ResolvedProviderCredential | null {
			const provider = input.registry.require(providerId);
			const definition = provider.definition.credential;
			const record = definition ? input.repo.get(providerId) : null;
			if (definition && !record) return null;
			const credential = record ? decodeCredential(provider, record) : null;
			return {
				providerId,
				revision: record ? record.revision : null,
				values: materializeSecrets(provider, credential, options),
			};
		},
		compareAndSet(update): ProviderCredentialUpdateResult {
			const provider = input.registry.get(update.providerId);
			if (!provider?.definition.credential) {
				return {
					accepted: false,
					currentRevision: null,
					safeReason: "Provider does not accept credential updates",
				};
			}
			const current = input.repo.get(provider.id);
			if (!current || current.revision !== update.expectedRevision) {
				return {
					accepted: false,
					currentRevision: current?.revision ?? null,
					safeReason: "Credential revision changed",
				};
			}
			const parsed = parseCredential(provider, update.value);
			const updated = input.repo.compareAndSet({
				providerId: provider.id,
				expectedRevision: update.expectedRevision,
				payload: encodeCredential(parsed),
			});
			if (!updated) {
				return {
					accepted: false,
					currentRevision: input.repo.get(provider.id)?.revision ?? null,
					safeReason: "Credential revision changed",
				};
			}
			return { accepted: true, currentRevision: updated.revision };
		},
	};
}

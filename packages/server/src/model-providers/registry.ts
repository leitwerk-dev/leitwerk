import type { CatalogPiContribution, OwnedModelProviderSet } from "@leitwerk-dev/extension-runtime";
import type { ModelProviderDefinition, ProviderCredentialStatus } from "@leitwerk-dev/process-sdk";
import type { ModelProfileSnapshot } from "@leitwerk-dev/protocol";
import { validateConfiguredProviderOptions } from "./provider-options.js";

export interface RegisteredModelProvider {
	readonly id: string;
	readonly ownerExtensionId: string;
	readonly packageName: string;
	readonly definition: ModelProviderDefinition;
	/** The parsed, non-secret provider configuration fragment. */
	readonly config: unknown;
	/** Configured credential seed, visible only to the credential service. */
	readonly configuredCredential: unknown | null;
	readonly piContribution: CatalogPiContribution | null;
}

export interface ModelProviderRegistry {
	readonly size: number;
	list(): readonly RegisteredModelProvider[];
	get(providerId: string): RegisteredModelProvider | null;
	require(providerId: string): RegisteredModelProvider;
}

export type ModelProviderCredentialStatusResolver = (
	provider: RegisteredModelProvider,
) => ProviderCredentialStatus | Promise<ProviderCredentialStatus>;

export const defaultModelProviderCredentialStatus: ModelProviderCredentialStatusResolver = (
	provider,
) =>
	provider.definition.credential
		? { available: false, revision: null }
		: { available: true, revision: null };

export interface CreateModelProviderRegistryInput {
	readonly sets: readonly OwnedModelProviderSet[];
	readonly piContributions: readonly CatalogPiContribution[];
	readonly extensionConfig: Readonly<Record<string, unknown>>;
	readonly modelProfiles: readonly ModelProfileSnapshot[];
	readonly titleModelProfileId: string | null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}

function contributionByOwner(
	contributions: readonly CatalogPiContribution[],
): ReadonlyMap<string, CatalogPiContribution> {
	const byOwner = new Map<string, CatalogPiContribution>();
	for (const contribution of contributions) {
		if (byOwner.has(contribution.ownerExtensionId)) {
			throw new Error(
				`Extension '${contribution.ownerExtensionId}' declares more than one Pi contribution`,
			);
		}
		byOwner.set(contribution.ownerExtensionId, contribution);
	}
	return byOwner;
}

interface OwnedResolvedModelProvider {
	readonly ownerExtensionId: string;
	readonly packageName: string;
	readonly definition: ModelProviderDefinition;
	readonly rawConfig: unknown;
}

function validatePiReferences(
	owned: OwnedResolvedModelProvider,
	contribution: CatalogPiContribution | null,
): void {
	const provider = owned.definition;
	if (provider.worker.kind === "extension_pi_worker" && !contribution?.workerEntryPath) {
		throw new Error(
			`Model provider '${provider.id}' owned by extension '${owned.ownerExtensionId}' requires that extension's declared Pi worker entry`,
		);
	}
	if (provider.server?.kind === "extension_pi_server" && !contribution?.serverEntryPath) {
		throw new Error(
			`Model provider '${provider.id}' owned by extension '${owned.ownerExtensionId}' requires that extension's declared Pi server entry`,
		);
	}
}

function validateConfiguredProfiles(
	providers: ReadonlyMap<string, RegisteredModelProvider>,
	profiles: readonly ModelProfileSnapshot[],
	titleModelProfileId: string | null,
): void {
	const profilesById = new Map<string, ModelProfileSnapshot>();
	for (const profile of profiles) {
		if (profilesById.has(profile.id)) {
			throw new Error(`Duplicate model profile id '${profile.id}'`);
		}
		profilesById.set(profile.id, profile);
		const provider = providers.get(profile.provider);
		if (!provider) {
			throw new Error(
				`Model profile '${profile.id}' names unknown provider '${profile.provider}'; load its owning extension before configuring the profile`,
			);
		}
		const optionIssues = validateConfiguredProviderOptions({
			provider,
			values: profile.provider_options ?? {},
		});
		if (optionIssues.length > 0) {
			throw new Error(
				`Invalid provider_options for model profile '${profile.id}': ${optionIssues.map((issue) => issue.message).join("; ")}`,
			);
		}
	}

	if (titleModelProfileId === null) {
		return;
	}
	const titleProfile = profilesById.get(titleModelProfileId);
	if (!titleProfile) {
		// The ordinary config validator owns the unknown-profile diagnostic. Keep
		// this boundary useful when called independently in tests or integrations.
		throw new Error(`Title model profile '${titleModelProfileId}' is not configured`);
	}
	const titleProvider = providers.get(titleProfile.provider);
	if (!titleProvider?.definition.server) {
		throw new Error(
			`Title model profile '${titleModelProfileId}' uses provider '${titleProfile.provider}', which has no server adapter`,
		);
	}
}

/**
 * Parse extension-owned provider configuration once and freeze the resulting
 * lookup. Provider definitions cannot be added from setupServer().
 */
export function createModelProviderRegistry(
	input: CreateModelProviderRegistryInput,
): ModelProviderRegistry {
	const contributions = contributionByOwner(input.piContributions);
	const providers = new Map<string, RegisteredModelProvider>();
	for (const set of input.sets) {
		let entries: ReturnType<OwnedModelProviderSet["resolve"]>;
		try {
			entries = set.resolve(input.extensionConfig[set.ownerExtensionId]);
			if (!Array.isArray(entries)) throw new Error("modelProviders must return an array");
		} catch (error) {
			throw new Error(
				`Invalid model provider configuration in extensions.${set.ownerExtensionId}: ${errorMessage(error)}`,
				{ cause: error },
			);
		}

		for (const entry of entries) {
			if (!entry || typeof entry !== "object" || !entry.definition) {
				throw new Error(
					`Extension '${set.ownerExtensionId}' returned an invalid model provider entry`,
				);
			}
			const owned: OwnedResolvedModelProvider = { ...set, ...entry };
			const providerId = owned.definition.id;
			const existing = providers.get(providerId);
			if (existing) {
				throw new Error(
					`Duplicate model provider id '${providerId}' declared by extensions '${existing.ownerExtensionId}' and '${owned.ownerExtensionId}'`,
				);
			}
			const piContribution = contributions.get(owned.ownerExtensionId) ?? null;
			validatePiReferences(owned, piContribution);

			let parsedConfig: unknown;
			let configuredCredential: unknown | null = null;
			try {
				const parsed = owned.definition.parseConfig(owned.rawConfig);
				if (
					typeof parsed !== "object" ||
					parsed === null ||
					Array.isArray(parsed) ||
					!("config" in parsed)
				) {
					throw new Error("parseConfig() must return { config, credential? }");
				}
				parsedConfig = parsed.config;
				if (parsed.credential !== undefined && parsed.credential !== null) {
					if (!owned.definition.credential) {
						throw new Error("configured credential requires a credential definition");
					}
					configuredCredential = owned.definition.credential.parse
						? owned.definition.credential.parse(parsed.credential)
						: parsed.credential;
				}
			} catch (error) {
				throw new Error(
					`Invalid model provider configuration for '${providerId}' in extensions.${owned.ownerExtensionId}: ${errorMessage(error)}`,
					{ cause: error },
				);
			}

			providers.set(providerId, {
				id: providerId,
				ownerExtensionId: owned.ownerExtensionId,
				packageName: owned.packageName,
				definition: owned.definition,
				config: parsedConfig,
				configuredCredential,
				piContribution,
			});
		}
	}

	validateConfiguredProfiles(providers, input.modelProfiles, input.titleModelProfileId);
	const orderedList = [...providers.values()];
	return {
		size: providers.size,
		list: () => orderedList,
		get: (providerId: string) => providers.get(providerId) ?? null,
		require(providerId: string) {
			const provider = providers.get(providerId);
			if (!provider) {
				throw new Error(`Unknown model provider '${providerId}'`);
			}
			return provider;
		},
	};
}

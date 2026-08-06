import { importPiServerAdapter } from "@leitwerk-dev/extension-runtime";
import type { PiServerAdapter } from "@leitwerk-dev/process-sdk";
import type { ModelProfileSnapshot } from "@leitwerk-dev/protocol";
import type { ModelProviderCredentialService } from "./credentials.js";
import { resolveRegisteredProviderOptions } from "./provider-options.js";
import type { ModelProviderRegistry, RegisteredModelProvider } from "./registry.js";

export type BuiltinPiServerAdapterFactory = (
	builtinProviderId: string,
	provider: RegisteredModelProvider,
) => PiServerAdapter | Promise<PiServerAdapter>;

export interface ModelProviderServerAdapterRegistry {
	get(providerId: string): PiServerAdapter | null;
	require(providerId: string): PiServerAdapter;
	generateText(input: {
		profileId: string;
		prompt: string;
		systemPrompt: string;
		maxTokens: number;
		request: {
			timeoutMs?: number;
			maxRetries?: number;
			maxRetryDelayMs: number;
		};
	}): Promise<string>;
}

export async function createModelProviderServerAdapterRegistry(input: {
	registry: ModelProviderRegistry;
	modelProfiles: readonly ModelProfileSnapshot[];
	credentials: ModelProviderCredentialService;
	createBuiltinAdapter: BuiltinPiServerAdapterFactory;
	loadExtensionAdapter?: (entryPath: string) => Promise<PiServerAdapter>;
}): Promise<ModelProviderServerAdapterRegistry> {
	const loadExtension = input.loadExtensionAdapter ?? importPiServerAdapter;
	const adapters = new Map<string, PiServerAdapter>();
	for (const provider of input.registry.list()) {
		const reference = provider.definition.server;
		if (!reference) continue;
		const adapter =
			reference.kind === "builtin_pi_provider"
				? await input.createBuiltinAdapter(reference.providerId, provider)
				: await loadExtension(provider.piContribution?.serverEntryPath as string);
		if (!adapter || typeof adapter.generateText !== "function") {
			throw new Error(`Model provider '${provider.id}' has an invalid server adapter`);
		}
		adapters.set(provider.id, adapter);
	}

	const profilesById = new Map(input.modelProfiles.map((profile) => [profile.id, profile]));
	return {
		get(providerId: string): PiServerAdapter | null {
			return adapters.get(providerId) ?? null;
		},
		require(providerId: string): PiServerAdapter {
			const adapter = adapters.get(providerId);
			if (!adapter) throw new Error(`Model provider '${providerId}' has no server adapter`);
			return adapter;
		},
		async generateText(
			request: Parameters<ModelProviderServerAdapterRegistry["generateText"]>[0],
		): Promise<string> {
			const profile = profilesById.get(request.profileId);
			if (!profile) throw new Error(`Unknown model profile '${request.profileId}'`);
			const provider = input.registry.require(profile.provider);
			const adapter = adapters.get(provider.id);
			if (!adapter) throw new Error(`Model provider '${provider.id}' has no server adapter`);
			const resolvedOptions = resolveRegisteredProviderOptions({
				provider,
				profileDefaults: profile.provider_options ?? {},
			});
			if (!resolvedOptions.ok) {
				throw new Error(
					`Invalid provider options for model profile '${profile.id}': ${resolvedOptions.issues.map((issue) => issue.message).join("; ")}`,
				);
			}
			const credential = input.credentials.resolve(provider.id, resolvedOptions.value);
			if (!credential) {
				throw new Error(`Provider credentials are unavailable for '${provider.id}'`);
			}
			return await adapter.generateText({
				providerId: provider.id,
				modelId: profile.model_id,
				thinkingLevel: profile.thinking_level ?? "off",
				prompt: request.prompt,
				systemPrompt: request.systemPrompt,
				maxTokens: request.maxTokens,
				config: provider.config,
				options: resolvedOptions.value,
				secrets: credential.values,
				request: request.request,
			});
		},
	};
}

import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { isUnknownRecord as isRecord } from "@leitwerk-dev/domain";
import {
	builtinPiProvider,
	configuredPiProvider,
	defineModelProvider,
	type ModelProviderDefinition,
	type ModelProviderModelsContext,
	type ModelProviderSetEntry,
	type ProviderModelStatus,
} from "@leitwerk-dev/process-sdk";
import * as v from "valibot";
import {
	getKnownEnvKeys,
	getStandardEnvApiKey,
	getSupportedStandardProviders,
} from "./provider-auth.js";

/** @internal */
export interface StandardProviderConfig {
	/** @internal */
	readonly baseUrl?: string;
	/** @internal */
	readonly models?: ReturnType<typeof normalizeStandardModels>;
}

/** @internal */
export interface ApiKeyCredential {
	/** @internal */
	readonly apiKey: string;
}

const nonEmptyStringSchema = v.pipe(
	v.string(),
	v.transform((value) => value.trim()),
	v.minLength(1),
);
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const nonNegativeNumberSchema = v.pipe(v.number(), v.finite(), v.minValue(0));
const thinkingLevelValueSchema = v.optional(v.nullable(nonEmptyStringSchema));
const thinkingLevelMapSchema = v.strictObject({
	/** @internal */
	off: thinkingLevelValueSchema,
	/** @internal */
	minimal: thinkingLevelValueSchema,
	/** @internal */
	low: thinkingLevelValueSchema,
	/** @internal */
	medium: thinkingLevelValueSchema,
	/** @internal */
	high: thinkingLevelValueSchema,
	/** @internal */
	xhigh: thinkingLevelValueSchema,
	/** @internal */
	max: thinkingLevelValueSchema,
});
// Compatibility options use Pi's names so they can be copied from models.json.
/** @internal */
const compatibilitySchema = v.strictObject({
	/** @internal */
	supportsStore: v.optional(v.boolean()),
	/** @internal */
	supportsDeveloperRole: v.optional(v.boolean()),
	/** @internal */
	supportsReasoningEffort: v.optional(v.boolean()),
	/** @internal */
	supportsUsageInStreaming: v.optional(v.boolean()),
	/** @internal */
	maxTokensField: v.optional(v.picklist(["max_tokens", "max_completion_tokens"])),
	/** @internal */
	supportsStrictMode: v.optional(v.boolean()),
	/** @internal */
	requiresReasoningContentOnAssistantMessages: v.optional(v.boolean()),
	/** @internal */
	thinkingFormat: v.optional(
		v.picklist([
			"openai",
			"openrouter",
			"deepseek",
			"together",
			"zai",
			"qwen",
			"chat-template",
			"qwen-chat-template",
			"string-thinking",
			"ant-ling",
		]),
	),
});
const modelCostSchema = v.strictObject({
	/** @internal */
	input: nonNegativeNumberSchema,
	/** @internal */
	output: nonNegativeNumberSchema,
	/** @internal */
	cacheRead: nonNegativeNumberSchema,
	/** @internal */
	cacheWrite: nonNegativeNumberSchema,
});
const baseUrlSchema = v.pipe(
	nonEmptyStringSchema,
	v.url(),
	v.check((value) => ["http:", "https:"].includes(new URL(value).protocol)),
	v.transform((value) => {
		const url = new URL(value);
		url.pathname = url.pathname.replace(/\/+$/u, "");
		return url.toString().replace(/\/$/u, "");
	}),
);
/** @internal */
const customModelSchema = v.pipe(
	v.strictObject({
		/** @internal */
		id: nonEmptyStringSchema,
		/** @internal */
		name: v.optional(nonEmptyStringSchema),
		/** @internal */
		reasoning: v.optional(v.boolean()),
		/** @internal */
		thinking_level_map: v.optional(thinkingLevelMapSchema),
		/** @internal */
		input: v.optional(v.pipe(v.array(v.picklist(["text", "image"])), v.minLength(1))),
		/** @internal */
		cost: v.optional(modelCostSchema),
		/** @internal */
		compat: v.optional(compatibilitySchema),
		/** @internal */
		context_window: v.optional(positiveIntegerSchema),
		/** @internal */
		max_tokens: v.optional(positiveIntegerSchema),
	}),
	v.transform(({ context_window, max_tokens, thinking_level_map, ...model }) => ({
		...model,
		...(thinking_level_map === undefined
			? {}
			: {
					/** @internal */
					thinkingLevelMap: thinking_level_map,
				}),
		...(context_window === undefined
			? {}
			: {
					/** @internal */
					contextWindow: context_window,
				}),
		...(max_tokens === undefined
			? {}
			: {
					/** @internal */
					maxTokens: max_tokens,
				}),
	})),
);
const modelDefinitionsSchema = v.pipe(
	v.array(customModelSchema),
	v.minLength(1),
	v.check(
		(models) => new Set(models.map(({ id }) => id)).size === models.length,
		"Duplicate model id",
	),
);
const customGatewaySchema = v.strictObject({
	base_url: baseUrlSchema,
	api_key: v.optional(v.nullable(v.union([v.literal(false), nonEmptyStringSchema]))),
	api: v.optional(
		v.picklist([
			"openai-completions",
			"openai-responses",
			"anthropic-messages",
			"google-generative-ai",
		]),
		"openai-completions",
	),
	compat: v.optional(compatibilitySchema),
	models: modelDefinitionsSchema,
});

/** @internal */
export type CustomModelDefinition = v.InferOutput<typeof customModelSchema>;

/** @internal */
export interface CustomGatewayConfig {
	/** @internal */
	readonly providerId: string;
	/** @internal */
	readonly baseUrl: string;
	/** @internal */
	readonly api: string;
	/** @internal */
	readonly keyless: boolean;
	/** @internal */
	readonly compat?: v.InferOutput<typeof compatibilitySchema>;
	/** @internal */
	readonly models: CustomModelDefinition[];
}

/** @internal */
function normalizeStandardModels(
	providerId: string,
	models: CustomModelDefinition[],
	baseUrl?: string,
) {
	const catalog = getBuiltinModels(providerId as never);
	return models.map((model) => {
		const reference = catalog.find(({ id }) => id === model.id) ?? catalog[0];
		if (!reference) throw new Error(`Provider '${providerId}' has no canonical API definition`);
		return {
			...model,
			/** @internal */
			provider: providerId,
			/** @internal */
			api: reference.api,
			/** @internal */
			baseUrl: baseUrl ?? reference.baseUrl,
			/** @internal */
			name: model.name ?? model.id,
			/** @internal */
			reasoning: model.reasoning ?? false,
			/** @internal */
			input: model.input ?? ["text" as const],
			/** @internal */
			cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			// Match Pi's defaults for explicitly configured models.
			/** @internal */
			contextWindow: model.contextWindow ?? 128_000,
			/** @internal */
			maxTokens: model.maxTokens ?? 16_384,
		};
	});
}

function assertKnownFields(
	value: Record<string, unknown>,
	allowed: readonly string[],
	location = "configuration",
): void {
	const known = new Set(allowed);
	const unknown = Object.keys(value).find((key) => !known.has(key));
	if (unknown) throw new Error(`${location} contains unknown field '${unknown}'`);
}

function nonEmptyString(value: unknown, location: string): string {
	if (typeof value !== "string") throw new Error(`${location} must be a string`);
	const normalized = value.trim();
	if (!normalized) throw new Error(`${location} must not be empty`);
	return normalized;
}

function resolveSecret(value: unknown, location: string): string {
	const configured = nonEmptyString(value, location);
	if (!configured.startsWith("env:")) return configured;
	const variable = nonEmptyString(configured.slice(4), `${location} environment variable`);
	const resolved = process.env[variable]?.trim();
	if (!resolved) throw new Error(`${location} references unset environment variable '${variable}'`);
	return resolved;
}

/** @internal */
export function parseApiKeyCredential(value: unknown, providerId: string): ApiKeyCredential {
	if (!isRecord(value)) throw new Error(`${providerId} credential must be an object`);
	assertKnownFields(value, ["apiKey"], `${providerId} credential`);
	return { apiKey: nonEmptyString(value.apiKey, `${providerId} credential apiKey`) };
}

function apiKeySecrets(credential: ApiKeyCredential | null): Readonly<Record<string, string>> {
	return credential ? { apiKey: credential.apiKey } : {};
}

/** @internal */
export function parseStandardProviderConfig(
	raw: unknown,
	providerId: string,
): {
	/** @internal */
	config: StandardProviderConfig;
	/** @internal */
	credential?: ApiKeyCredential;
} {
	if (raw !== undefined && raw !== null && !isRecord(raw)) {
		throw new Error("configuration must be an object");
	}
	const rawConfig = (raw ?? {}) as Record<string, unknown>;
	assertKnownFields(rawConfig, ["api_key", "base_url", "models"]);
	const apiKey =
		rawConfig.api_key === undefined || rawConfig.api_key === null
			? getStandardEnvApiKey(providerId)
			: resolveSecret(rawConfig.api_key, "api_key");
	const baseUrl =
		rawConfig.base_url === undefined || rawConfig.base_url === null
			? undefined
			: v.parse(baseUrlSchema, resolveSecret(rawConfig.base_url, "base_url"));
	return {
		config: {
			...(baseUrl ? { baseUrl } : {}),
			...(rawConfig.models === undefined
				? {}
				: {
						models: normalizeStandardModels(
							providerId,
							v.parse(modelDefinitionsSchema, rawConfig.models),
							baseUrl,
						),
					}),
		},
		...(apiKey ? { credential: { apiKey } } : {}),
	};
}

function catalogModelStatuses(
	ctx: ModelProviderModelsContext,
	knownModelIds: ReadonlySet<string>,
	credentialsAvailable: boolean,
	missingReason: (modelId: string) => string,
	credentialReason: string,
): readonly ProviderModelStatus[] {
	return [...new Set(ctx.configuredModels.map(({ modelId }) => modelId))].map((modelId) =>
		!knownModelIds.has(modelId)
			? { modelId, availability: "unavailable", safeReason: missingReason(modelId) }
			: credentialsAvailable
				? { modelId, availability: "available" }
				: { modelId, availability: "unavailable", safeReason: credentialReason },
	);
}

/** @internal */
export function evaluateStandardModelStatuses(
	providerId: string,
	ctx: ModelProviderModelsContext<StandardProviderConfig>,
): readonly ProviderModelStatus[] {
	return catalogModelStatuses(
		ctx,
		new Set([
			...getBuiltinModels(providerId as never).map(({ id }) => id),
			...(ctx.config.models ?? []).map(({ id }) => id),
		]),
		ctx.credentialStatus.available,
		(modelId) => `Canonical Pi model '${providerId}/${modelId}' is not found in catalog`,
		`${providerId} credentials are unavailable (set ${getKnownEnvKeys(providerId).join(" or ")})`,
	);
}

/** @internal */
export function createStandardModelProvider(
	providerId: string,
): ModelProviderDefinition<StandardProviderConfig, ApiKeyCredential> {
	const reference = builtinPiProvider(providerId);
	return defineModelProvider({
		id: providerId,
		parseConfig: (raw) => parseStandardProviderConfig(raw, providerId),
		worker: configuredPiProvider(providerId, ({ config }) => ({
			providers: config.baseUrl || config.models ? { [providerId]: { ...config } } : {},
		})),
		server: reference,
		models: (ctx) => evaluateStandardModelStatuses(providerId, ctx),
		credential: { parse: (value) => parseApiKeyCredential(value, providerId) },
		secrets: ({ credential }) => apiKeySecrets(credential),
	});
}

/** @internal */
export function parseCustomGatewayConfig(
	providerId: string,
	raw: unknown,
): {
	/** @internal */
	config: CustomGatewayConfig;
	/** @internal */
	credential?: ApiKeyCredential;
} {
	const parsed = v.parse(customGatewaySchema, raw);
	const keyless = parsed.api_key === false;
	const apiKey =
		keyless || parsed.api_key === undefined || parsed.api_key === null
			? undefined
			: resolveSecret(parsed.api_key, "api_key");
	return {
		config: {
			providerId,
			baseUrl: parsed.base_url,
			api: parsed.api,
			keyless,
			...(parsed.compat === undefined ? {} : { compat: parsed.compat }),
			models: parsed.models,
		},
		...(apiKey ? { credential: { apiKey } } : {}),
	};
}

/** @internal */
export function createCustomGatewayProvider(
	providerId: string,
	keyless: boolean,
): ModelProviderDefinition<CustomGatewayConfig, ApiKeyCredential> {
	return defineModelProvider({
		id: providerId,
		parseConfig: (raw) => parseCustomGatewayConfig(providerId, raw),
		worker: configuredPiProvider(providerId, ({ config }) => ({
			providers: {
				[config.providerId]: {
					baseUrl: config.baseUrl,
					api: config.api,
					...(config.compat === undefined ? {} : { compat: config.compat }),
					models: config.models,
				},
			},
		})),
		models: (ctx) =>
			catalogModelStatuses(
				ctx,
				new Set(ctx.config.models.map(({ id }) => id)),
				ctx.config.keyless || ctx.credentialStatus.available,
				(modelId) =>
					`Canonical model '${ctx.config.providerId}/${modelId}' is not found in custom gateway definition`,
				`Gateway provider '${ctx.config.providerId}' credentials are unavailable`,
			),
		...(keyless
			? {}
			: { credential: { parse: (value: unknown) => parseApiKeyCredential(value, providerId) } }),
		secrets: ({ credential }) =>
			apiKeySecrets(credential ?? (keyless ? { apiKey: "leitwerk-keyless" } : null)),
	});
}

/** @internal */
export function resolveModelProviders(raw: unknown): readonly ModelProviderSetEntry[] {
	if (raw !== undefined && raw !== null && !isRecord(raw)) {
		throw new Error("configuration must be an object");
	}
	const owner = (raw ?? {}) as Record<string, unknown>;
	const standardIds = getSupportedStandardProviders();
	assertKnownFields(owner, [...standardIds, "custom_gateways"]);
	const entries: ModelProviderSetEntry[] = standardIds.map((providerId) => ({
		definition: createStandardModelProvider(providerId),
		rawConfig: owner[providerId],
	}));
	if (owner.custom_gateways === undefined) return entries;
	if (!isRecord(owner.custom_gateways)) throw new Error("custom_gateways must be an object");
	for (const [providerId, gateway] of Object.entries(owner.custom_gateways)) {
		if (!providerId.trim()) throw new Error("custom gateway provider id must not be empty");
		entries.push({
			definition: createCustomGatewayProvider(
				providerId,
				isRecord(gateway) && gateway.api_key === false,
			),
			rawConfig: gateway,
		});
	}
	return entries;
}

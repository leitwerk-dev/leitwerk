import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
	builtinPiProvider,
	configuredPiProvider,
	defineModelProvider,
	type ModelProviderDefinition,
	type ModelProviderModelsContext,
	type ModelProviderSetEntry,
	type ProviderJsonObject,
	type ProviderModelStatus,
} from "@leitwerk-dev/process-sdk";
import * as v from "valibot";
import {
	getKnownEnvKeys,
	getStandardEnvApiKey,
	getSupportedStandardProviders,
} from "./provider-auth.js";

export type EmptyProviderConfig = Record<string, never>;

export interface ApiKeyCredential {
	readonly apiKey: string;
}

const nonEmptyStringSchema = v.pipe(
	v.string(),
	v.transform((value) => value.trim()),
	v.minLength(1),
);
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const customModelSchema = v.pipe(
	v.strictObject({
		id: nonEmptyStringSchema,
		name: v.optional(nonEmptyStringSchema),
		reasoning: v.optional(v.boolean()),
		context_window: v.optional(positiveIntegerSchema),
		max_tokens: v.optional(positiveIntegerSchema),
	}),
	v.transform(({ context_window, max_tokens, ...model }) => ({
		...model,
		...(context_window === undefined ? {} : { contextWindow: context_window }),
		...(max_tokens === undefined ? {} : { maxTokens: max_tokens }),
	})),
);
const customGatewaySchema = v.strictObject({
	base_url: v.pipe(
		nonEmptyStringSchema,
		v.url(),
		v.check((value) => ["http:", "https:"].includes(new URL(value).protocol)),
		v.transform((value) => new URL(value).toString().replace(/\/$/, "")),
	),
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
	models: v.pipe(v.array(customModelSchema), v.minLength(1)),
});

export type CustomModelDefinition = v.InferOutput<typeof customModelSchema>;

export interface CustomGatewayConfig {
	readonly providerId: string;
	readonly baseUrl: string;
	readonly api: string;
	readonly keyless: boolean;
	readonly models: CustomModelDefinition[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function parseApiKeyCredential(value: unknown, providerId: string): ApiKeyCredential {
	if (!isRecord(value)) throw new Error(`${providerId} credential must be an object`);
	assertKnownFields(value, ["apiKey"], `${providerId} credential`);
	return { apiKey: nonEmptyString(value.apiKey, `${providerId} credential apiKey`) };
}

function apiKeySecrets(credential: ApiKeyCredential | null): Readonly<Record<string, string>> {
	return credential ? { apiKey: credential.apiKey } : {};
}

export function parseStandardProviderConfig(
	raw: unknown,
	providerId: string,
): { config: EmptyProviderConfig; credential?: ApiKeyCredential } {
	if (raw !== undefined && raw !== null && !isRecord(raw)) {
		throw new Error("configuration must be an object");
	}
	const config = (raw ?? {}) as Record<string, unknown>;
	assertKnownFields(config, ["api_key"]);
	const apiKey =
		config.api_key === undefined || config.api_key === null
			? getStandardEnvApiKey(providerId)
			: resolveSecret(config.api_key, "api_key");
	return { config: {}, ...(apiKey ? { credential: { apiKey } } : {}) };
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

export function evaluateStandardModelStatuses(
	providerId: string,
	ctx: ModelProviderModelsContext,
): readonly ProviderModelStatus[] {
	return catalogModelStatuses(
		ctx,
		new Set(getBuiltinModels(providerId as never).map(({ id }) => id)),
		ctx.credentialStatus.available,
		(modelId) => `Canonical Pi model '${providerId}/${modelId}' is not found in catalog`,
		`${providerId} credentials are unavailable (set ${getKnownEnvKeys(providerId).join(" or ")})`,
	);
}

export function createStandardModelProvider(
	providerId: string,
): ModelProviderDefinition<EmptyProviderConfig, ApiKeyCredential> {
	const reference = builtinPiProvider(providerId);
	return defineModelProvider({
		id: providerId,
		parseConfig: (raw) => parseStandardProviderConfig(raw, providerId),
		worker: reference,
		server: reference,
		models: (ctx) => evaluateStandardModelStatuses(providerId, ctx),
		credential: { parse: (value) => parseApiKeyCredential(value, providerId) },
		secrets: ({ credential }) => apiKeySecrets(credential),
	});
}

export function parseCustomGatewayConfig(
	providerId: string,
	raw: unknown,
): { config: CustomGatewayConfig; credential?: ApiKeyCredential } {
	const parsed = v.parse(customGatewaySchema, raw);
	const ids = new Set<string>();
	for (const model of parsed.models) {
		if (ids.has(model.id)) throw new Error(`duplicate custom model id '${model.id}'`);
		ids.add(model.id);
	}
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
			models: parsed.models,
		},
		...(apiKey ? { credential: { apiKey } } : {}),
	};
}

function customGatewayPiModels(config: CustomGatewayConfig): ProviderJsonObject {
	return {
		providers: {
			[config.providerId]: {
				baseUrl: config.baseUrl,
				api: config.api,
				models: config.models,
			},
		},
	};
}

function customGatewayModelStatuses(
	config: CustomGatewayConfig,
	ctx: ModelProviderModelsContext<CustomGatewayConfig>,
): readonly ProviderModelStatus[] {
	return catalogModelStatuses(
		ctx,
		new Set(config.models.map(({ id }) => id)),
		config.keyless || ctx.credentialStatus.available,
		(modelId) =>
			`Canonical model '${config.providerId}/${modelId}' is not found in custom gateway definition`,
		`Gateway provider '${config.providerId}' credentials are unavailable`,
	);
}

export function createCustomGatewayProvider(
	providerId: string,
	keyless: boolean,
): ModelProviderDefinition<CustomGatewayConfig, ApiKeyCredential> {
	return defineModelProvider({
		id: providerId,
		parseConfig: (raw) => parseCustomGatewayConfig(providerId, raw),
		worker: configuredPiProvider(providerId, ({ config }) => customGatewayPiModels(config)),
		models: (ctx) => customGatewayModelStatuses(ctx.config, ctx),
		...(keyless
			? {}
			: { credential: { parse: (value: unknown) => parseApiKeyCredential(value, providerId) } }),
		secrets: ({ credential }) =>
			apiKeySecrets(credential ?? (keyless ? { apiKey: "leitwerk-keyless" } : null)),
	});
}

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

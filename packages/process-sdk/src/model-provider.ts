/** JSON values that may cross the server/worker bootstrap boundary. */
export type ProviderJsonPrimitive = string | number | boolean | null;
export type ProviderJsonValue =
	| ProviderJsonPrimitive
	| ProviderJsonValue[]
	| { [key: string]: ProviderJsonValue };
export type ProviderJsonObject = { [key: string]: ProviderJsonValue };

export interface ConfiguredProviderModel {
	readonly profileId: string;
	readonly modelId: string;
}

export type ProviderAvailability = "available" | "unavailable" | "stale";

export interface ProviderModelStatus {
	readonly modelId: string;
	readonly availability: ProviderAvailability;
	/** Safe operator-facing reason. It must not contain credential material. */
	readonly safeReason?: string;
}

export interface ProviderCredentialStatus {
	readonly available: boolean;
	readonly revision: number | null;
}

export interface ModelProviderModelsContext<TConfig = unknown> {
	readonly config: TConfig;
	readonly configuredModels: readonly ConfiguredProviderModel[];
	readonly credentialStatus: ProviderCredentialStatus;
}

export interface ProviderOptionChoice {
	readonly value: string;
	readonly label: string;
}

export interface ProviderOptionChoicesContext<TConfig = unknown> {
	readonly config: TConfig;
	readonly credentialStatus: ProviderCredentialStatus;
}

export interface ProviderOptionDefaultContext<TConfig = unknown> {
	readonly config: TConfig;
}

export interface ProviderOptionField<TConfig = unknown> {
	readonly label: string;
	readonly required?: boolean;
	readonly minLength?: number;
	readonly maxLength?: number;
	/**
	 * Explicit provider default. Dynamic choices are advisory and are never used
	 * as an implicit default.
	 */
	readonly defaultValue?:
		| string
		| null
		| ((ctx: ProviderOptionDefaultContext<TConfig>) => string | null | undefined);
}

export interface ProviderOptionsDefinition<TConfig = unknown> {
	readonly fields: Readonly<Record<string, ProviderOptionField<TConfig>>>;
	choices?(
		ctx: ProviderOptionChoicesContext<TConfig>,
	):
		| Readonly<Record<string, readonly ProviderOptionChoice[]>>
		| Promise<Readonly<Record<string, readonly ProviderOptionChoice[]>>>;
}

export function defineProviderOptions<TConfig = unknown>(
	definition: ProviderOptionsDefinition<TConfig>,
): ProviderOptionsDefinition<TConfig> {
	for (const [fieldId, field] of Object.entries(definition.fields)) {
		if (fieldId.trim() === "") {
			throw new Error("Provider option field ids must not be empty");
		}
		if (
			field.minLength !== undefined &&
			(!Number.isInteger(field.minLength) || field.minLength < 0)
		) {
			throw new Error(`Provider option '${fieldId}' minLength must be a non-negative integer`);
		}
		if (
			field.maxLength !== undefined &&
			(!Number.isInteger(field.maxLength) || field.maxLength < 0)
		) {
			throw new Error(`Provider option '${fieldId}' maxLength must be a non-negative integer`);
		}
		if (
			field.minLength !== undefined &&
			field.maxLength !== undefined &&
			field.minLength > field.maxLength
		) {
			throw new Error(`Provider option '${fieldId}' minLength must not exceed maxLength`);
		}
	}
	return { ...definition, fields: { ...definition.fields } };
}

export interface ProviderOptionsResolutionInput<TConfig = unknown> {
	readonly definition: ProviderOptionsDefinition<TConfig> | null | undefined;
	readonly config: TConfig;
	readonly explicit?: Readonly<Record<string, unknown>> | null;
	readonly profileDefaults?: Readonly<Record<string, unknown>> | null;
}

export interface ProviderOptionValidationIssue {
	readonly fieldId: string;
	readonly code: "unknown" | "not_string" | "too_short" | "too_long" | "required";
	readonly message: string;
}

export type ProviderOptionsResolution =
	| { readonly ok: true; readonly value: Readonly<Record<string, string>> }
	| { readonly ok: false; readonly issues: readonly ProviderOptionValidationIssue[] };

function validateOptionValue<TConfig>(
	fieldId: string,
	field: ProviderOptionField<TConfig>,
	value: unknown,
): ProviderOptionValidationIssue | null {
	if (typeof value !== "string") {
		return {
			fieldId,
			code: "not_string",
			message: `Provider option '${fieldId}' must be a string`,
		};
	}
	if (field.minLength !== undefined && value.length < field.minLength) {
		return {
			fieldId,
			code: "too_short",
			message: `Provider option '${fieldId}' must contain at least ${field.minLength} characters`,
		};
	}
	if (field.maxLength !== undefined && value.length > field.maxLength) {
		return {
			fieldId,
			code: "too_long",
			message: `Provider option '${fieldId}' must contain at most ${field.maxLength} characters`,
		};
	}
	return null;
}

/**
 * Resolve explicit values, profile defaults, then declared provider defaults.
 * Dynamic choices deliberately do not participate in validation or fallback.
 */
export function resolveProviderOptions<TConfig = unknown>(
	input: ProviderOptionsResolutionInput<TConfig>,
): ProviderOptionsResolution {
	const fields = input.definition?.fields ?? {};
	const issues: ProviderOptionValidationIssue[] = [];
	for (const source of [input.explicit, input.profileDefaults]) {
		for (const fieldId of Object.keys(source ?? {})) {
			if (!(fieldId in fields)) {
				issues.push({
					fieldId,
					code: "unknown",
					message: `Unknown provider option '${fieldId}'`,
				});
			}
		}
	}
	if (issues.length > 0) {
		return { ok: false, issues };
	}

	const resolved: Record<string, string> = {};
	for (const [fieldId, field] of Object.entries(fields)) {
		const explicit = input.explicit?.[fieldId];
		const profileDefault = input.profileDefaults?.[fieldId];
		const declaredDefault =
			typeof field.defaultValue === "function"
				? field.defaultValue({ config: input.config })
				: field.defaultValue;
		const value = explicit ?? profileDefault ?? declaredDefault;
		if (value === undefined || value === null) {
			if (field.required) {
				issues.push({
					fieldId,
					code: "required",
					message: `Provider option '${fieldId}' is required`,
				});
			}
			continue;
		}
		const issue = validateOptionValue(fieldId, field, value);
		if (issue) {
			issues.push(issue);
			continue;
		}
		resolved[fieldId] = value as string;
	}
	return issues.length > 0 ? { ok: false, issues } : { ok: true, value: resolved };
}

/** Keep only fields declared by a newly selected provider. */
export function filterProviderOptionsForDefinition<TConfig = unknown>(
	definition: ProviderOptionsDefinition<TConfig> | null | undefined,
	values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	const fields = definition?.fields ?? {};
	return Object.fromEntries(Object.entries(values).filter(([fieldId]) => fieldId in fields));
}

/**
 * Runtime-independent schema boundary for non-secret provider worker config.
 * Adapters may wrap Valibot, TypeBox, Zod, or another validator behind parse.
 */
export interface ProviderWorkerConfigSchema<TValue extends ProviderJsonObject> {
	parse(value: unknown): TValue;
}

export interface ProviderWorkerConfigContext<TConfig = unknown> {
	readonly config: TConfig;
	readonly options: Readonly<Record<string, string>>;
}

export interface ProviderWorkerConfigDefinition<
	TConfig = unknown,
	TValue extends ProviderJsonObject = ProviderJsonObject,
> {
	readonly version: number;
	readonly schema: ProviderWorkerConfigSchema<TValue>;
	resolve(ctx: ProviderWorkerConfigContext<TConfig>): TValue;
}

export function defineWorkerConfig<
	TConfig = unknown,
	TValue extends ProviderJsonObject = ProviderJsonObject,
>(
	definition: ProviderWorkerConfigDefinition<TConfig, TValue>,
): ProviderWorkerConfigDefinition<TConfig, TValue> {
	if (!Number.isInteger(definition.version) || definition.version < 1) {
		throw new Error("Provider worker config version must be a positive integer");
	}
	return definition;
}

export interface PiWorkerReference<
	TConfig = unknown,
	TValue extends ProviderJsonObject = ProviderJsonObject,
> {
	readonly kind: "extension_pi_worker";
	readonly config?: ProviderWorkerConfigDefinition<TConfig, TValue>;
	/** Mutable, flat JSON credential files required by this provider's Pi extension. */
	readonly credentialFiles?: readonly string[];
}

export interface PiServerReference {
	readonly kind: "extension_pi_server";
}

export interface PiServerGenerateTextInput<TConfig = unknown> {
	readonly providerId: string;
	readonly modelId: string;
	readonly thinkingLevel: string;
	readonly prompt: string;
	readonly systemPrompt: string;
	readonly maxTokens: number;
	readonly config: TConfig;
	readonly options: Readonly<Record<string, string>>;
	readonly secrets: Readonly<Record<string, string>>;
	readonly request: {
		readonly timeoutMs?: number;
		readonly maxRetries?: number;
		readonly maxRetryDelayMs: number;
	};
}

/** Server-only provider boundary for title generation and future cheap LLM consumers. */
export interface PiServerAdapter<TConfig = unknown> {
	generateText(input: PiServerGenerateTextInput<TConfig>): Promise<string>;
}

export function definePiServerAdapter<TConfig = unknown>(
	adapter: PiServerAdapter<TConfig>,
): PiServerAdapter<TConfig> {
	if (!adapter || typeof adapter.generateText !== "function") {
		throw new Error("Pi server adapter must define generateText()");
	}
	return adapter;
}

export interface BuiltinPiProviderReference {
	readonly kind: "builtin_pi_provider";
	readonly providerId: string;
}

export interface ConfiguredPiProviderReference<TConfig = unknown> {
	readonly kind: "configured_pi_provider";
	readonly providerId: string;
	/** Resolve the credential-blind models.json document pinned into each worker snapshot. */
	resolveModels(ctx: { readonly config: TConfig }): ProviderJsonObject;
}

export function piWorker<TConfig = unknown, TValue extends ProviderJsonObject = ProviderJsonObject>(
	input: {
		config?: ProviderWorkerConfigDefinition<TConfig, TValue>;
		credentialFiles?: readonly string[];
	} = {},
): PiWorkerReference<TConfig, TValue> {
	const credentialFiles = input.credentialFiles?.map((file) => {
		if (!file || file.startsWith("/") || file.includes("..") || file.includes("\\\\")) {
			throw new Error("Pi worker credential file must be a relative path");
		}
		return file;
	});
	return {
		kind: "extension_pi_worker",
		...input,
		...(credentialFiles ? { credentialFiles } : {}),
	};
}

export function piServer(): PiServerReference {
	return { kind: "extension_pi_server" };
}

export function builtinPiProvider(providerId: string): BuiltinPiProviderReference {
	if (providerId.trim() === "") {
		throw new Error("Built-in Pi provider id must not be empty");
	}
	return { kind: "builtin_pi_provider", providerId };
}

export function configuredPiProvider<TConfig>(
	providerId: string,
	resolveModels: ConfiguredPiProviderReference<TConfig>["resolveModels"],
): ConfiguredPiProviderReference<TConfig> {
	if (providerId.trim() === "") {
		throw new Error("Configured Pi provider id must not be empty");
	}
	return { kind: "configured_pi_provider", providerId, resolveModels };
}

export type ModelProviderWorker<
	TConfig = unknown,
	TValue extends ProviderJsonObject = ProviderJsonObject,
> =
	| PiWorkerReference<TConfig, TValue>
	| BuiltinPiProviderReference
	| ConfiguredPiProviderReference<TConfig>;

export type ModelProviderServer = PiServerReference | BuiltinPiProviderReference;

export interface ModelProviderSecretsContext<TConfig = unknown, TCredential = unknown> {
	readonly config: TConfig;
	readonly credential: TCredential | null;
	readonly options: Readonly<Record<string, string>>;
}

export interface ParsedModelProviderConfig<TConfig = unknown, TCredential = unknown> {
	/** Restart-scoped, non-secret provider configuration. */
	readonly config: TConfig;
	/** Optional credential used only to initialize an empty durable credential store. */
	readonly credential?: TCredential;
}

export interface ModelProviderCredentialDefinition<TCredential = unknown> {
	/** Validates configured, durable, and worker-refreshed credential data. */
	parse?(value: unknown): TCredential;
}

export interface ModelProviderDefinition<
	TConfig = unknown,
	TCredential = unknown,
	TWorkerConfig extends ProviderJsonObject = ProviderJsonObject,
> {
	readonly id: string;
	parseConfig(raw: unknown): ParsedModelProviderConfig<TConfig, TCredential>;
	readonly worker: ModelProviderWorker<TConfig, TWorkerConfig>;
	readonly server?: ModelProviderServer;
	models(
		ctx: ModelProviderModelsContext<TConfig>,
	): readonly ProviderModelStatus[] | Promise<readonly ProviderModelStatus[]>;
	readonly options?: ProviderOptionsDefinition<TConfig>;
	secrets(ctx: ModelProviderSecretsContext<TConfig, TCredential>): Readonly<Record<string, string>>;
	readonly credential?: ModelProviderCredentialDefinition<TCredential>;
}

export function defineModelProvider<
	TConfig = unknown,
	TCredential = unknown,
	TWorkerConfig extends ProviderJsonObject = ProviderJsonObject,
>(
	definition: ModelProviderDefinition<TConfig, TCredential, TWorkerConfig>,
): ModelProviderDefinition<TConfig, TCredential, TWorkerConfig> {
	if (definition.id.trim() === "") {
		throw new Error("Model provider id must not be empty");
	}
	return definition;
}

/** Type-erased provider definition used after its typed boundary has been established. */
// biome-ignore lint/suspicious/noExplicitAny: provider sets intentionally erase provider-owned generic types
export type ErasedModelProviderDefinition = ModelProviderDefinition<any, any, any>;

export interface ModelProviderSetEntry {
	readonly definition: ErasedModelProviderDefinition;
	/** Owner-scoped fragment passed to this provider's parseConfig(). */
	readonly rawConfig: unknown;
}

/** Resolves every provider owned by one extension from its owner-scoped configuration. */
export type ModelProviderSet = (ownerConfig: unknown) => readonly ModelProviderSetEntry[];

export function defineModelProviders(resolve: ModelProviderSet): ModelProviderSet {
	return resolve;
}

export interface PiWorkerSecretBag {
	get(key: string): string | undefined;
	require(key: string): string;
	keys(): readonly string[];
}

export interface PiWorkerContributionContext {
	readonly model: { readonly providerId: string; readonly modelId: string };
	readonly options: Readonly<Record<string, string>>;
	readonly workerConfig: ProviderJsonObject | null;
	readonly secrets: PiWorkerSecretBag;
	report(event: Readonly<Record<string, ProviderJsonValue>>): void;
}

export type PiWorkerContribution = (
	pi: { registerProvider(name: string, config: object): void },
	ctx: PiWorkerContributionContext,
) => void | Promise<void>;

export function definePiWorker(contribution: PiWorkerContribution): PiWorkerContribution {
	return contribution;
}

/**
 * Report each distinct configured model as available or unavailable based solely
 * on credential status. Providers that do not perform runtime model probing can
 * delegate their `models()` callback to this helper.
 */
export function credentialBasedModelStatuses(
	configuredModels: readonly ConfiguredProviderModel[],
	credentialStatus: ProviderCredentialStatus,
	unavailableReason: string,
): readonly ProviderModelStatus[] {
	const seen = new Set<string>();
	const statuses: ProviderModelStatus[] = [];
	for (const configured of configuredModels) {
		if (seen.has(configured.modelId)) continue;
		seen.add(configured.modelId);
		statuses.push({
			modelId: configured.modelId,
			availability: credentialStatus.available ? "available" : "unavailable",
			...(credentialStatus.available ? {} : { safeReason: unavailableReason }),
		});
	}
	return statuses;
}

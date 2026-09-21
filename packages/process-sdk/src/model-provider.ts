/** JSON values that may cross the server/worker bootstrap boundary. @public */
export type ProviderJsonPrimitive = string | number | boolean | null;
/** @public */
export type ProviderJsonValue =
	| ProviderJsonPrimitive
	| ProviderJsonValue[]
	| {
			/** @internal */
			[key: string]: ProviderJsonValue;
	  };
/** @public */
export type ProviderJsonObject = {
	/** @internal */
	[key: string]: ProviderJsonValue;
};

/** @public */
export interface ConfiguredProviderModel {
	/** @public */
	readonly profileId: string;
	/** @public */
	readonly modelId: string;
}

/** @public */
export type ProviderAvailability = "available" | "unavailable" | "stale";

/** @public */
export interface ProviderModelStatus {
	/** @public */
	readonly modelId: string;
	/** @public */
	readonly availability: ProviderAvailability;
	/** Safe operator-facing reason. It must not contain credential material. @internal */
	readonly safeReason?: string;
}

/** @public */
export interface ProviderCredentialStatus {
	/** @public */
	readonly available: boolean;
	/** @public */
	readonly revision: number | null;
}

/** @public */
export interface ModelProviderModelsContext<TConfig = unknown> {
	/** @internal */
	readonly config: TConfig;
	/** @public */
	readonly configuredModels: readonly ConfiguredProviderModel[];
	/** @public */
	readonly credentialStatus: ProviderCredentialStatus;
}

/** @public */
export interface ProviderOptionChoice {
	/** @internal */
	readonly value: string;
	/** @internal */
	readonly label: string;
}

/** @public */
export interface ProviderOptionChoicesContext<TConfig = unknown> {
	/** @internal */
	readonly config: TConfig;
	/** @internal */
	readonly credentialStatus: ProviderCredentialStatus;
}

/** @internal */
export interface ProviderOptionDefaultContext<TConfig = unknown> {
	/** @internal */
	readonly config: TConfig;
}

/** @public */
export interface ProviderOptionField<TConfig = unknown> {
	/** @public */
	readonly label: string;
	/** @public */
	readonly required?: boolean;
	/** @internal */
	readonly minLength?: number;
	/** @public */
	readonly maxLength?: number;
	/**
	 * Explicit provider default. Dynamic choices are advisory and are never used
	 * as an implicit default.
	 */
	/** @internal */
	readonly defaultValue?:
		| string
		| null
		| ((ctx: ProviderOptionDefaultContext<TConfig>) => string | null | undefined);
}

/** @public */
export interface ProviderOptionsDefinition<TConfig = unknown> {
	/** @public */
	readonly fields: Readonly<Record<string, ProviderOptionField<TConfig>>>;
	/** @public */
	choices?(
		ctx: ProviderOptionChoicesContext<TConfig>,
	):
		| Readonly<Record<string, readonly ProviderOptionChoice[]>>
		| Promise<Readonly<Record<string, readonly ProviderOptionChoice[]>>>;
}

/** @public */
export function defineProviderOptions<TConfig = unknown>(
	definition: ProviderOptionsDefinition<TConfig>,
): ProviderOptionsDefinition<TConfig> {
	for (const [fieldId, field] of Object.entries(definition.fields)) {
		if (fieldId.trim() === "") {
			throw new Error("Provider option field ids must not be empty");
		}
		for (const bound of ["minLength", "maxLength"] as const) {
			const value = field[bound];
			if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
				throw new Error(`Provider option '${fieldId}' ${bound} must be a non-negative integer`);
			}
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

/** @internal */
export interface ProviderOptionsResolutionInput<TConfig = unknown> {
	/** @internal */
	readonly definition: ProviderOptionsDefinition<TConfig> | null | undefined;
	/** @internal */
	readonly config: TConfig;
	/** @internal */
	readonly explicit?: Readonly<Record<string, unknown>> | null;
	/** @internal */
	readonly profileDefaults?: Readonly<Record<string, unknown>> | null;
}

/** @internal */
export interface ProviderOptionValidationIssue {
	/** @internal */
	readonly fieldId: string;
	/** @internal */
	readonly code: "unknown" | "not_string" | "too_short" | "too_long" | "required";
	/** @internal */
	readonly message: string;
}

/** @internal */
export type ProviderOptionsResolution =
	| {
			/** @internal */
			readonly ok: true;
			/** @internal */
			readonly value: Readonly<Record<string, string>>;
	  }
	| {
			/** @internal */
			readonly ok: false;
			/** @internal */
			readonly issues: readonly ProviderOptionValidationIssue[];
	  };

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
/** @internal */
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

/** Keep only fields declared by a newly selected provider. @internal */
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
/** @public */
export interface ProviderWorkerConfigSchema<TValue extends ProviderJsonObject> {
	/** @public */
	parse(value: unknown): TValue;
}

/** @public */
export interface ProviderWorkerConfigContext<TConfig = unknown> {
	/** @public */
	readonly config: TConfig;
	/** @internal */
	readonly options: Readonly<Record<string, string>>;
}

/** @public */
export interface ProviderWorkerConfigDefinition<
	TConfig = unknown,
	TValue extends ProviderJsonObject = ProviderJsonObject,
> {
	/** @public */
	readonly version: number;
	/** @public */
	readonly schema: ProviderWorkerConfigSchema<TValue>;
	/** @public */
	resolve(ctx: ProviderWorkerConfigContext<TConfig>): TValue;
}

/** @public */
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

/** @public */
export interface PiWorkerReference<
	TConfig = unknown,
	TValue extends ProviderJsonObject = ProviderJsonObject,
> {
	/** @public */
	readonly kind: "extension_pi_worker";
	/** @internal */
	readonly config?: ProviderWorkerConfigDefinition<TConfig, TValue>;
	/** Mutable, flat JSON credential files required by this provider's Pi extension. @internal */
	readonly credentialFiles?: readonly string[];
}

/** @public */
export interface PiServerReference {
	/** @internal */
	readonly kind: "extension_pi_server";
}

/** @public */
export interface PiServerGenerateTextInput<TConfig = unknown> {
	/** @public */
	readonly providerId: string;
	/** @public */
	readonly modelId: string;
	/** @public */
	readonly thinkingLevel: string;
	/** @public */
	readonly prompt: string;
	/** @public */
	readonly systemPrompt: string;
	/** @public */
	readonly maxTokens: number;
	/** @public */
	readonly config: TConfig;
	/** @public */
	readonly options: Readonly<Record<string, string>>;
	/** @public */
	readonly secrets: Readonly<Record<string, string>>;
	/** @public */
	readonly request: {
		/** @public */
		readonly timeoutMs?: number;
		/** @internal */
		readonly maxRetries?: number;
		/** @public */
		readonly maxRetryDelayMs: number;
	};
}

/** Server-only provider boundary for title generation and future cheap LLM consumers. @public */
export interface PiServerAdapter<TConfig = unknown> {
	/** @public */
	generateText(input: PiServerGenerateTextInput<TConfig>): Promise<string>;
}

/** @public */
export function definePiServerAdapter<TConfig = unknown>(
	adapter: PiServerAdapter<TConfig>,
): PiServerAdapter<TConfig> {
	if (!adapter || typeof adapter.generateText !== "function") {
		throw new Error("Pi server adapter must define generateText()");
	}
	return adapter;
}

/** @public */
export interface BuiltinPiProviderReference {
	/** @public */
	readonly kind: "builtin_pi_provider";
	/** @internal */
	readonly providerId: string;
}

/** @public */
export interface ConfiguredPiProviderReference<TConfig = unknown> {
	/** @public */
	readonly kind: "configured_pi_provider";
	/** @internal */
	readonly providerId: string;
	/** Resolve the credential-blind models.json document pinned into each worker snapshot. @internal */
	resolveModels(ctx: {
		/** @internal */
		readonly config: TConfig;
	}): ProviderJsonObject;
}

/** @public */
export function piWorker<TConfig = unknown, TValue extends ProviderJsonObject = ProviderJsonObject>(
	input: {
		/** @public */
		config?: ProviderWorkerConfigDefinition<TConfig, TValue>;
		/** @public */
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

/** @public */
export function piServer(): PiServerReference {
	return { kind: "extension_pi_server" };
}

/** @public */
export function builtinPiProvider(providerId: string): BuiltinPiProviderReference {
	if (providerId.trim() === "") {
		throw new Error("Built-in Pi provider id must not be empty");
	}
	return { kind: "builtin_pi_provider", providerId };
}

/** @internal */
export function configuredPiProvider<TConfig>(
	providerId: string,
	resolveModels: ConfiguredPiProviderReference<TConfig>["resolveModels"],
): ConfiguredPiProviderReference<TConfig> {
	if (providerId.trim() === "") {
		throw new Error("Configured Pi provider id must not be empty");
	}
	return { kind: "configured_pi_provider", providerId, resolveModels };
}

/** @public */
export type ModelProviderWorker<
	TConfig = unknown,
	TValue extends ProviderJsonObject = ProviderJsonObject,
> =
	| PiWorkerReference<TConfig, TValue>
	| BuiltinPiProviderReference
	| ConfiguredPiProviderReference<TConfig>;

/** @public */
export type ModelProviderServer = PiServerReference | BuiltinPiProviderReference;

/** @public */
export interface ModelProviderSecretsContext<TConfig = unknown, TCredential = unknown> {
	/** @internal */
	readonly config: TConfig;
	/** @public */
	readonly credential: TCredential | null;
	/** @internal */
	readonly options: Readonly<Record<string, string>>;
}

/** @public */
export interface ParsedModelProviderConfig<TConfig = unknown, TCredential = unknown> {
	/** Restart-scoped, non-secret provider configuration. @public */
	readonly config: TConfig;
	/** Optional credential used only to initialize an empty durable credential store. @internal */
	readonly credential?: TCredential;
}

/** @public */
export interface ModelProviderCredentialDefinition<TCredential = unknown> {
	/** Validates configured, durable, and worker-refreshed credential data. @public */
	parse?(value: unknown): TCredential;
}

/** @public */
export interface ModelProviderDefinition<
	TConfig = unknown,
	TCredential = unknown,
	TWorkerConfig extends ProviderJsonObject = ProviderJsonObject,
> {
	/** @public */
	readonly id: string;
	/** @public */
	parseConfig(raw: unknown): ParsedModelProviderConfig<TConfig, TCredential>;
	/** @public */
	readonly worker: ModelProviderWorker<TConfig, TWorkerConfig>;
	/** @public */
	readonly server?: ModelProviderServer;
	/** @public */
	models(
		ctx: ModelProviderModelsContext<TConfig>,
	): readonly ProviderModelStatus[] | Promise<readonly ProviderModelStatus[]>;
	/** @public */
	readonly options?: ProviderOptionsDefinition<TConfig>;
	/** @public */
	secrets(ctx: ModelProviderSecretsContext<TConfig, TCredential>): Readonly<Record<string, string>>;
	/** @public */
	readonly credential?: ModelProviderCredentialDefinition<TCredential>;
}

/** @public */
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

/** Type-erased provider definition used after its typed boundary has been established. @public */
// biome-ignore lint/suspicious/noExplicitAny: provider sets intentionally erase provider-owned generic types
export type ErasedModelProviderDefinition = ModelProviderDefinition<any, any, any>;

/** @public */
export interface ModelProviderSetEntry {
	/** @public */
	readonly definition: ErasedModelProviderDefinition;
	/** Owner-scoped fragment passed to this provider's parseConfig(). @public */
	readonly rawConfig: unknown;
}

/** Resolves every provider owned by one extension from its owner-scoped configuration. @public */
export type ModelProviderSet = (ownerConfig: unknown) => readonly ModelProviderSetEntry[];

/** @public */
export function defineModelProviders(resolve: ModelProviderSet): ModelProviderSet {
	return resolve;
}

/** @public */
export interface PiWorkerSecretBag {
	/** @public */
	get(key: string): string | undefined;
	/** @public */
	require(key: string): string;
	/** @public */
	keys(): readonly string[];
}

/** @public */
export interface PiWorkerContributionContext {
	/** @public */
	readonly model: {
		/** @public */
		readonly providerId: string;
		/** @public */
		readonly modelId: string;
	};
	/** @public */
	readonly options: Readonly<Record<string, string>>;
	/** @public */
	readonly workerConfig: ProviderJsonObject | null;
	/** @public */
	readonly secrets: PiWorkerSecretBag;
	/** @public */
	report(event: Readonly<Record<string, ProviderJsonValue>>): void;
}

/** @public */
export type PiWorkerContribution = (
	pi: {
		/** @public */
		registerProvider(name: string, config: object): void;
	},
	ctx: PiWorkerContributionContext,
) => void | Promise<void>;

/** @public */
export function definePiWorker(contribution: PiWorkerContribution): PiWorkerContribution {
	return contribution;
}

/**
 * Report each distinct configured model as available or unavailable based solely
 * on credential status. Providers that do not perform runtime model probing can
 * delegate their `models()` callback to this helper.
 */
/** @public */
export function credentialBasedModelStatuses(
	configuredModels: readonly ConfiguredProviderModel[],
	credentialStatus: ProviderCredentialStatus,
	unavailableReason: string,
): readonly ProviderModelStatus[] {
	return [...new Set(configuredModels.map((configured) => configured.modelId))].map((modelId) => ({
		modelId,
		availability: credentialStatus.available ? "available" : "unavailable",
		...(credentialStatus.available ? {} : { safeReason: unavailableReason }),
	}));
}

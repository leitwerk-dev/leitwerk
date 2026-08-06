import {
	type ProviderOptionChoice,
	type ProviderOptionsResolution,
	type ProviderOptionValidationIssue,
	resolveProviderOptions,
} from "@leitwerk-dev/process-sdk";
import { positiveBound, validateCredentialStatus, withTimeout } from "./provider-boundary-utils.js";
import type { ModelProviderCredentialStatusResolver, RegisteredModelProvider } from "./registry.js";

const DEFAULT_OPTION_CHOICE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CHOICE_FIELDS = 64;
const DEFAULT_MAX_CHOICES_PER_FIELD = 256;
const DEFAULT_MAX_CHOICE_TEXT_LENGTH = 512;

export interface ResolveRegisteredProviderOptionsInput {
	readonly provider: RegisteredModelProvider;
	readonly explicit?: Readonly<Record<string, unknown>> | null;
	readonly profileDefaults?: Readonly<Record<string, unknown>> | null;
}

/**
 * Resolve structural option values. Dynamic choices are deliberately absent:
 * they are advisory UI data, not an allowlist or fallback source.
 */
export function resolveRegisteredProviderOptions(
	input: ResolveRegisteredProviderOptionsInput,
): ProviderOptionsResolution {
	return resolveProviderOptions({
		definition: input.provider.definition.options,
		config: input.provider.config,
		explicit: input.explicit,
		profileDefaults: input.profileDefaults,
	});
}

export function validateConfiguredProviderOptions(input: {
	readonly provider: RegisteredModelProvider;
	readonly values: Readonly<Record<string, unknown>>;
}): readonly ProviderOptionValidationIssue[] {
	const result = resolveRegisteredProviderOptions({
		provider: input.provider,
		profileDefaults: input.values,
	});
	if (result.ok) {
		return [];
	}
	// Required options may be supplied explicitly for an individual start. A
	// profile default is therefore allowed to omit them; all other structural
	// defects make startup configuration malformed.
	return result.issues.filter((issue) => issue.code !== "required");
}

export type ProviderOptionChoicesResult =
	| {
			readonly ok: true;
			readonly choices: Readonly<Record<string, readonly ProviderOptionChoice[]>>;
	  }
	| { readonly ok: false; readonly safeReason: string };

export interface LoadProviderOptionChoicesInput {
	readonly provider: RegisteredModelProvider;
	readonly credentialStatus: ModelProviderCredentialStatusResolver;
	readonly timeoutMs?: number;
	readonly maxFields?: number;
	readonly maxChoicesPerField?: number;
	readonly maxTextLength?: number;
}

/** Fetch bounded advisory choices without making them part of option validation. */
export async function loadProviderOptionChoices(
	input: LoadProviderOptionChoicesInput,
): Promise<ProviderOptionChoicesResult> {
	const choicesLoader = input.provider.definition.options?.choices;
	if (!choicesLoader) {
		return { ok: true, choices: {} };
	}
	const timeoutMs = positiveBound(
		input.timeoutMs,
		DEFAULT_OPTION_CHOICE_TIMEOUT_MS,
		"Provider option choice timeout",
	);
	const maxFields = positiveBound(
		input.maxFields,
		DEFAULT_MAX_CHOICE_FIELDS,
		"Maximum choice fields",
	);
	const maxChoices = positiveBound(
		input.maxChoicesPerField,
		DEFAULT_MAX_CHOICES_PER_FIELD,
		"Maximum choices per field",
	);
	const maxTextLength = positiveBound(
		input.maxTextLength,
		DEFAULT_MAX_CHOICE_TEXT_LENGTH,
		"Maximum choice text length",
	);

	try {
		const credentialStatus = validateCredentialStatus(
			await withTimeout(Promise.resolve(input.credentialStatus(input.provider)), timeoutMs),
		);
		const raw = await withTimeout(
			Promise.resolve(choicesLoader({ config: input.provider.config, credentialStatus })),
			timeoutMs,
		);
		const entries = Object.entries(raw);
		if (entries.length > maxFields) {
			throw new Error("too many fields");
		}
		const fields = input.provider.definition.options?.fields ?? {};
		const bounded: Record<string, readonly ProviderOptionChoice[]> = {};
		for (const [fieldId, choices] of entries) {
			if (!(fieldId in fields) || !Array.isArray(choices) || choices.length > maxChoices) {
				throw new Error("invalid field choices");
			}
			bounded[fieldId] = choices.map((choice) => {
				if (
					typeof choice?.value !== "string" ||
					typeof choice?.label !== "string" ||
					choice.value.length > maxTextLength ||
					choice.label.length > maxTextLength
				) {
					throw new Error("invalid choice");
				}
				return { value: choice.value, label: choice.label };
			});
		}
		return { ok: true, choices: bounded };
	} catch (error) {
		return {
			ok: false,
			safeReason:
				error instanceof Error && error.message === "timeout"
					? "Provider option choices timed out"
					: "Provider option choices are temporarily unavailable",
		};
	}
}

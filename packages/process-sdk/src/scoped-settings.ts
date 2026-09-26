import type { ResolvedSetting, SettingsContext, SettingsSubject } from "@leitwerk-dev/domain";
import { createCapabilityToken } from "./capabilities.js";

/** Non-secret, JSON-compatible setting owned and validated by an extension. @public */
export interface SettingDefinition<T = unknown> {
	/** Namespaced, for example coding.planning_model. @public */
	key: string;
	/** Increment when stored values cease to satisfy the contract. @public */
	schemaVersion: number;
	/** Must reject invalid values without coercing missing overrides into empty values. @public */
	schema: {
		/** @public */
		parse(value: unknown): T;
	};
	/** @public */
	defaultValue: T;
	/** Least to most specific, including instance where applicable. @public */
	scopes: readonly string[];
	/** @public */
	merge: "replace" | "instructions";
	/** @public */
	form: {
		/** @public */
		label: string;
		/** @public */
		description?: string;
		/** @public */
		group: string;
		/** @public */
		control: "text" | "textarea" | "select" | "model" | "number" | "checkbox";
	};
	/** Dynamic non-secret choices for generic forms. @public */
	choices?(context: SettingsContext): readonly SettingChoice[] | Promise<readonly SettingChoice[]>;
}

/** @public */
export interface SettingChoice {
	/** @public */
	value: string;
	/** @public */
	label: string;
	/** @public */
	disabledReason?: string;
}

/** @public */
export interface SettingsScopeDefinition {
	/** Namespaced; instance and repository are provided by core. @public */
	id: string;
	/** @public */
	label: string;
}

/** Trusted server-side discovery input. @public */
export interface SettingsSubjectInput {
	/** @public */
	scopeType: string;
	/** Stable identity, independent of the display name. @public */
	identity: string;
	/** @public */
	label: string;
	/** @public */
	context?: SettingsContext;
	/** Normalized locators known by the provider to identify this repository. @public */
	aliases?: readonly string[];
}

/** Extension-owned purpose; separate from the internal title-generation model purpose. @public */
export interface ExecutionPurposeDefinition {
	/** @public */
	id: string;
	/** @public */
	label: string;
	/** A nullable model-profile setting. Null delegates to YAML/catalog defaults. @public */
	modelSettingKey?: string;
	/** Only these non-secret values are captured and sent to the worker. @public */
	settingKeys?: readonly string[];
	/** Composed independently per repository, with repository labels. @public */
	instructionSettingKeys?: readonly string[];
}

/** @public */
export interface ScopedSettingsDeclaration {
	/** @public */
	scopes?: readonly SettingsScopeDefinition[];
	/** @public */
	settings: readonly SettingDefinition[];
	/** @public */
	purposes?: readonly ExecutionPurposeDefinition[];
}

/** Server-only capability. Workers receive immutable start snapshots. @public */
export interface ScopedSettingsResolver {
	/** @public */
	resolve<T>(definition: SettingDefinition<T>, context: SettingsContext): ResolvedSetting<T>;
	/** Retains stable subject identities and known aliases across rediscovery. @public */
	discover(input: SettingsSubjectInput): SettingsSubject;
	/** Called only by explicit discovery, never during step preparation. @public */
	registerDiscovery(
		scopeType: string,
		discover: () => Promise<readonly SettingsSubjectInput[]>,
	): void;
}

/** @public */
export const scopedSettingsCapability =
	createCapabilityToken<ScopedSettingsResolver>("core:scopedSettings");

/** Provider origins and stable IDs define identity; clone URLs are aliases. @public */
export function repositorySettingsIdentity(origin: string, repositoryId: string | number): string {
	return `provider:${JSON.stringify([new URL(origin).origin, String(repositoryId)])}`;
}

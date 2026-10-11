import type { ResolvedSetting, SettingsContext, SettingsSubject } from "@leitwerk-dev/domain";
import type {
	SettingChoice,
	SettingMetadata,
	SettingsScopeOverview,
} from "@leitwerk-dev/protocol/http-contracts";
import { createCapabilityToken } from "./capabilities.js";

export type { NamedSelection, SettingChoice } from "@leitwerk-dev/protocol/http-contracts";

/** Non-secret, JSON-compatible setting owned and validated by an extension. @public */
export interface SettingDefinition<T = unknown> extends SettingMetadata {
	/** Must reject invalid values without coercing missing overrides into empty values. @public */
	schema: {
		/** @public */
		parse(value: unknown): T;
	};
	/** @public */
	defaultValue: T;
	/** Label retained selections synchronously, without remote discovery. @public */
	choiceLabel?(value: string): string;
	/** Dynamic non-secret choices for generic forms. @public */
	choices?(
		context: SettingsContext,
		request?: {
			/** Search text supplied by the operator. @public */
			search?: string;
			/** Saved selections that must remain discoverable while searching. @public */
			values?: readonly string[];
		},
	): readonly SettingChoice[] | Promise<readonly SettingChoice[]>;
}

/** @public */
export interface SettingsScopeDefinition {
	/** Namespaced; instance and repository are provided by core. @public */
	id: string;
	/** @public */
	label: string;
	/** Optional display names and label grouping for the generic scope overview. @public */
	overview?: SettingsScopeOverview;
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
	/** Read a retained subject by stable identity without discovery or remote requests. @public */
	findSubject(scopeType: string, identity: string): SettingsSubject | null;
	/** Read a retained subject by ID, including retained redirects. @public */
	getSubject(id: string): SettingsSubject | null;
	/** Initialize a field once. Existing overrides and explicit resets are preserved. @public */
	seedOverride<T>(subjectId: string, definition: SettingDefinition<T>, value: T): boolean;
	/** Retains stable subject identities and known aliases across rediscovery. @public */
	discover(input: SettingsSubjectInput): SettingsSubject;
	/** Called only by explicit discovery, never during step preparation. @public */
	registerDiscovery(
		scopeType: string,
		discover: () => Promise<readonly SettingsSubjectInput[]>,
		options?: {
			/** Limit navigation without deleting retained subjects or overrides. @public */
			includesSubject?: (
				subject: SettingsSubject,
				context: Readonly<Record<string, SettingsSubject>>,
			) => boolean;
		},
	): void;
}

/** @public */
export const scopedSettingsCapability =
	createCapabilityToken<ScopedSettingsResolver>("core:scopedSettings");

/** Provider origins and stable IDs define identity; clone URLs are aliases. @public */
export function repositorySettingsIdentity(origin: string, repositoryId: string | number): string {
	return `provider:${JSON.stringify([new URL(origin).origin, String(repositoryId)])}`;
}

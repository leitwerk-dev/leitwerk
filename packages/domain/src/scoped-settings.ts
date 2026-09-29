import type { Actor } from "./domain-model.js";

/** One stable subject per named scope type. @public */
export type SettingsContext = Readonly<Record<string, string>>;

/** @public */
export interface SettingsSubject {
	/** @public */
	id: string;
	/** @public */
	scopeType: string;
	/** @public */
	identity: string;
	/** @public */
	label: string;
	/** Lower scopes supplied by the owning integration, never matched by expression. @public */
	context: SettingsContext;
	/** @public */
	schemaVersion: number;
	/** @public */
	revision: number;
	/** @public */
	createdAt: string;
	/** @public */
	updatedAt: string;
	/** Discovery is attributed to the server system actor. @public */
	actor: Actor;
}

/** A reset retains its revision to prevent delete/recreate races. @internal */
export interface SettingsOverride {
	/** @internal */
	subjectId: string;
	/** @internal */
	key: string;
	/** @internal */
	value: unknown;
	/** @internal */
	mode: "append" | "replace";
	/** @internal */
	reset: boolean;
	/** @internal */
	schemaVersion: number;
	/** @internal */
	revision: number;
	/** @internal */
	createdAt: string;
	/** @internal */
	updatedAt: string;
	/** @internal */
	actor: Actor;
}

/** @public */
export interface SettingsSource {
	/** @public */
	subjectId: string | null;
	/** @public */
	scopeType: string;
	/** @public */
	label: string;
	/** @public */
	revision: number;
	/** @public */
	schemaVersion: number;
	/** @public */
	mode: "append" | "replace";
}

/** @public */
export interface ResolvedSetting<T = unknown> {
	/** @public */
	key: string;
	/** @public */
	value: T;
	/** @public */
	sources: SettingsSource[];
}

/** Immutable, non-secret settings consumed by a prepared turn. @public */
export interface ScopedSettingsSnapshot {
	/** @public */
	version: 1;
	/** @public */
	purpose: string;
	/** @public */
	context: SettingsContext;
	/** @public */
	values: ResolvedSetting[];
	/** Instruction blocks are labelled so repositories cannot be confused. @public */
	instructions: Array<{
		/** @public */
		label: string;
		/** @public */
		setting: ResolvedSetting<string>;
	}>;
	/** @public */
	explanations: string[];
}

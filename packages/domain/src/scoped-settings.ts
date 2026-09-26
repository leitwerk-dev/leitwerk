import type { Actor } from "./domain-model.js";

/** One stable subject per named scope type. @internal */
export type SettingsContext = Readonly<Record<string, string>>;

/** @internal */
export interface SettingsSubject {
	/** @internal */
	id: string;
	/** @internal */
	scopeType: string;
	/** @internal */
	identity: string;
	/** @internal */
	label: string;
	/** Lower scopes supplied by the owning integration, never matched by expression. @internal */
	context: SettingsContext;
	/** @internal */
	schemaVersion: number;
	/** @internal */
	revision: number;
	/** @internal */
	createdAt: string;
	/** @internal */
	updatedAt: string;
	/** Discovery is attributed to the server system actor. @internal */
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

/** @internal */
export interface SettingsSource {
	/** @internal */
	subjectId: string | null;
	/** @internal */
	scopeType: string;
	/** @internal */
	label: string;
	/** @internal */
	revision: number;
	/** @internal */
	schemaVersion: number;
	/** @internal */
	mode: "append" | "replace";
}

/** @internal */
export interface ResolvedSetting<T = unknown> {
	/** @internal */
	key: string;
	/** @internal */
	value: T;
	/** @internal */
	sources: SettingsSource[];
}

/** Immutable, non-secret settings consumed by a prepared turn. @internal */
export interface ScopedSettingsSnapshot {
	/** @internal */
	version: 1;
	/** @internal */
	purpose: string;
	/** @internal */
	context: SettingsContext;
	/** @internal */
	values: ResolvedSetting[];
	/** Instruction blocks are labelled so repositories cannot be confused. @internal */
	instructions: Array<{
		/** @internal */
		label: string;
		/** @internal */
		setting: ResolvedSetting<string>;
	}>;
	/** @internal */
	explanations: string[];
}

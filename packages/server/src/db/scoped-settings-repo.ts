import type {
	Actor,
	SettingsContext,
	SettingsOverride,
	SettingsSubject,
} from "@leitwerk-dev/domain";
import { SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { and, eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

/** @internal */
export interface SettingsWrite {
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
	expectedRevision: number;
	/** @internal */
	actor: Actor;
}
/** @internal */
interface SubjectWrite {
	/** @internal */
	id?: string;
	/** @internal */
	scopeType: string;
	/** @internal */
	identity: string;
	/** @internal */
	label: string;
	/** @internal */
	context: SettingsContext;
}

function subject(row: typeof s.settingsSubjects.$inferSelect): SettingsSubject {
	const { contextJson, actorJson, ...rest } = row;
	return { ...rest, context: JSON.parse(contextJson), actor: JSON.parse(actorJson) };
}

function override(row: typeof s.settingsOverrides.$inferSelect): SettingsOverride {
	const { valueJson, actorJson, mode, ...rest } = row;
	return {
		...rest,
		mode: mode as SettingsOverride["mode"],
		value: JSON.parse(valueJson),
		actor: JSON.parse(actorJson),
	};
}

/** @internal */
export function createScopedSettingsRepo(db: LeitwerkDb) {
	return {
		/** @internal */
		listSubjects(): SettingsSubject[] {
			return db.select().from(s.settingsSubjects).all().map(subject);
		},
		/** @internal */
		getSubject(id: string): SettingsSubject | null {
			const row = db.select().from(s.settingsSubjects).where(eq(s.settingsSubjects.id, id)).get();
			return row ? subject(row) : null;
		},
		/** @internal */
		findIdentity(scopeType: string, identity: string): SettingsSubject | null {
			const row = db
				.select()
				.from(s.settingsSubjects)
				.where(
					and(
						eq(s.settingsSubjects.scopeType, scopeType),
						eq(s.settingsSubjects.identity, identity),
					),
				)
				.get();
			return row ? subject(row) : null;
		},
		/** @internal */
		findAlias(alias: string): SettingsSubject | null {
			const row = db
				.select()
				.from(s.settingsAliases)
				.where(eq(s.settingsAliases.alias, alias))
				.get();
			return row ? this.getSubject(row.subjectId) : null;
		},
		/** @internal */
		putSubject(input: SubjectWrite): SettingsSubject {
			const ts = now();
			const previous = input.id ? this.getSubject(input.id) : null;
			const values = {
				id: input.id ?? generateId("scope"),
				scopeType: input.scopeType,
				identity: input.identity,
				label: input.label,
				contextJson: JSON.stringify(input.context),
				schemaVersion: 1,
				revision: (previous?.revision ?? 0) + 1,
				createdAt: previous?.createdAt ?? ts,
				updatedAt: ts,
				actorJson: JSON.stringify(SYSTEM_ACTOR),
			};
			db.insert(s.settingsSubjects)
				.values(values)
				.onConflictDoUpdate({ target: s.settingsSubjects.id, set: values })
				.run();
			return subject(values);
		},
		/** @internal */
		putAlias(alias: string, subjectId: string): void {
			db.insert(s.settingsAliases).values({ alias, subjectId }).onConflictDoNothing().run();
			if (this.findAlias(alias)?.id !== subjectId)
				throw new Error(`Repository alias '${alias}' already belongs to another settings subject`);
		},
		/** @internal */
		listOverrides(subjectId?: string): SettingsOverride[] {
			return db
				.select()
				.from(s.settingsOverrides)
				.where(subjectId ? eq(s.settingsOverrides.subjectId, subjectId) : undefined)
				.all()
				.map(override);
		},
		/** @internal */
		getOverride(subjectId: string, key: string): SettingsOverride | null {
			const row = db
				.select()
				.from(s.settingsOverrides)
				.where(and(eq(s.settingsOverrides.subjectId, subjectId), eq(s.settingsOverrides.key, key)))
				.get();
			return row ? override(row) : null;
		},
		/** Atomic compare-and-swap, including resets and first writes. @internal */
		write(input: SettingsWrite): SettingsOverride | null {
			const ts = now();
			const values = {
				subjectId: input.subjectId,
				key: input.key,
				valueJson: JSON.stringify(input.value),
				mode: input.mode,
				reset: input.reset,
				schemaVersion: input.schemaVersion,
				revision: input.expectedRevision + 1,
				createdAt: ts,
				updatedAt: ts,
				actorJson: JSON.stringify(input.actor),
			};
			const { createdAt: _createdAt, ...update } = values;
			if (input.expectedRevision > 0) {
				const row = db
					.update(s.settingsOverrides)
					.set(update)
					.where(
						and(
							eq(s.settingsOverrides.subjectId, input.subjectId),
							eq(s.settingsOverrides.key, input.key),
							eq(s.settingsOverrides.revision, input.expectedRevision),
						),
					)
					.returning()
					.get();
				return row ? override(row) : null;
			}
			const row = db
				.insert(s.settingsOverrides)
				.values(values)
				.onConflictDoNothing()
				.returning()
				.get();
			return row ? override(row) : null;
		},
	};
}

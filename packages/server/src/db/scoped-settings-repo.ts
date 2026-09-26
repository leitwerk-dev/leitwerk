import type {
	Actor,
	SettingsContext,
	SettingsOverride,
	SettingsSubject,
} from "@leitwerk-dev/domain";
import { SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { and, eq, notInArray } from "drizzle-orm";
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
			return db
				.select()
				.from(s.settingsSubjects)
				.where(
					notInArray(
						s.settingsSubjects.id,
						db
							.select({ id: s.settingsSubjectRedirects.subjectId })
							.from(s.settingsSubjectRedirects),
					),
				)
				.all()
				.map(subject);
		},
		/** @internal */
		getSubject(id: string): SettingsSubject | null {
			const visited = new Set<string>();
			while (!visited.has(id)) {
				visited.add(id);
				const redirect = db
					.select()
					.from(s.settingsSubjectRedirects)
					.where(eq(s.settingsSubjectRedirects.subjectId, id))
					.get();
				if (!redirect) {
					const row = db
						.select()
						.from(s.settingsSubjects)
						.where(eq(s.settingsSubjects.id, id))
						.get();
					return row ? subject(row) : null;
				}
				id = redirect.canonicalSubjectId;
			}
			throw new Error("Cyclic settings subject redirects");
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
			return row ? this.getSubject(row.id) : null;
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
			const canonicalId = subjectId ? (this.getSubject(subjectId)?.id ?? subjectId) : undefined;
			return db
				.select()
				.from(s.settingsOverrides)
				.where(
					canonicalId
						? eq(s.settingsOverrides.subjectId, canonicalId)
						: notInArray(
								s.settingsOverrides.subjectId,
								db
									.select({ id: s.settingsSubjectRedirects.subjectId })
									.from(s.settingsSubjectRedirects),
							),
				)
				.all()
				.map(override);
		},
		/** @internal */
		getOverride(subjectId: string, key: string): SettingsOverride | null {
			subjectId = this.getSubject(subjectId)?.id ?? subjectId;
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
				subjectId: this.getSubject(input.subjectId)?.id ?? input.subjectId,
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
							eq(s.settingsOverrides.subjectId, values.subjectId),
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
		/** Call inside a transaction after verifying that active overrides agree. @internal */
		mergeLocatorSubject(sourceId: string, targetId: string): void {
			const source = this.getSubject(sourceId);
			const target = this.getSubject(targetId);
			if (
				!source ||
				!target ||
				source.id === target.id ||
				source.scopeType !== "repository" ||
				target.scopeType !== "repository" ||
				!source.identity.startsWith("locator:")
			)
				throw new Error("Only distinct locator subjects can merge into a repository");
			for (const incoming of this.listOverrides(source.id)) {
				const current = this.getOverride(target.id, incoming.key);
				const retained = current && !current.reset ? current : incoming;
				const values = {
					subjectId: target.id,
					key: retained.key,
					valueJson: JSON.stringify(retained.value),
					mode: retained.mode,
					reset: retained.reset,
					schemaVersion: retained.schemaVersion,
					revision: Math.max(incoming.revision, current?.revision ?? 0) + 1,
					createdAt: retained.createdAt,
					updatedAt: now(),
					actorJson: JSON.stringify(retained.actor),
				};
				db.insert(s.settingsOverrides)
					.values(values)
					.onConflictDoUpdate({
						target: [s.settingsOverrides.subjectId, s.settingsOverrides.key],
						set: values,
					})
					.run();
			}
			db.update(s.settingsAliases)
				.set({ subjectId: target.id })
				.where(eq(s.settingsAliases.subjectId, source.id))
				.run();
			// Keep original subjects and overrides for historical references and attribution.
			db.insert(s.settingsSubjectRedirects)
				.values({ subjectId: source.id, canonicalSubjectId: target.id })
				.run();
		},
	};
}

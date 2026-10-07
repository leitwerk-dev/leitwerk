import type { Actor } from "@leitwerk-dev/domain";
import { and, eq, gt, lt } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { now } from "./repo-helpers.js";
import * as s from "./schema.js";

/** @internal */
export interface AuthSessionRecord {
	/** @internal */
	idHash: string;
	/** @internal */
	actor: Actor;
	/** @internal */
	createdAt: string;
	/** @internal */
	expiresAt: string;
}

/** @internal */
export interface AuthLoginFlowRecord {
	/** @internal */
	idHash: string;
	/** @internal */
	providerId: string;
	/** @internal */
	state: string;
	/** @internal */
	pkceVerifier: string;
	/** @internal */
	createdAt: string;
	/** @internal */
	expiresAt: string;
}

function sessionRowToRecord(row: typeof s.authSessions.$inferSelect): AuthSessionRecord {
	return {
		idHash: row.idHash,
		actor: {
			id: row.actorId,
			kind: "user",
			provider: row.actorProvider as Actor["provider"],
			...(row.displayName && { displayName: row.displayName }),
		},
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
	};
}

/** @internal */
export function createAuthSessionRepo(db: LeitwerkDb) {
	return {
		/** @internal */
		create(input: {
			/** @internal */
			idHash: string;
			/** @internal */
			actor: Actor;
			/** @internal */
			expiresAt: string;
		}): AuthSessionRecord {
			const ts = now();
			const values = {
				idHash: input.idHash,
				actorId: input.actor.id,
				actorProvider: input.actor.provider,
				displayName: input.actor.displayName ?? null,
				createdAt: ts,
				expiresAt: input.expiresAt,
			};
			db.insert(s.authSessions).values(values).run();
			return sessionRowToRecord(values);
		},

		/** @internal */
		getValid(idHash: string, atIso: string = now()): AuthSessionRecord | null {
			const row = db
				.select()
				.from(s.authSessions)
				.where(and(eq(s.authSessions.idHash, idHash), gt(s.authSessions.expiresAt, atIso)))
				.get();
			return row ? sessionRowToRecord(row) : null;
		},

		/** @internal */
		delete(idHash: string): boolean {
			const result = db.delete(s.authSessions).where(eq(s.authSessions.idHash, idHash)).run();
			return result.changes > 0;
		},

		/** @internal */
		deleteExpired(atIso: string = now()): number {
			const result = db.delete(s.authSessions).where(lt(s.authSessions.expiresAt, atIso)).run();
			return Number(result.changes);
		},
	};
}

/** @internal */
export function createAuthLoginFlowRepo(db: LeitwerkDb) {
	return {
		/** @internal */
		create(input: {
			/** @internal */
			idHash: string;
			/** @internal */
			providerId: string;
			/** @internal */
			state: string;
			/** @internal */
			pkceVerifier: string;
			/** @internal */
			expiresAt: string;
		}): AuthLoginFlowRecord {
			const values = {
				idHash: input.idHash,
				providerId: input.providerId,
				state: input.state,
				pkceVerifier: input.pkceVerifier,
				createdAt: now(),
				expiresAt: input.expiresAt,
			};
			db.insert(s.authLoginFlows).values(values).run();
			return values;
		},

		/** @internal */
		getValid(idHash: string, atIso: string = now()): AuthLoginFlowRecord | null {
			const row = db
				.select()
				.from(s.authLoginFlows)
				.where(and(eq(s.authLoginFlows.idHash, idHash), gt(s.authLoginFlows.expiresAt, atIso)))
				.get();
			return row ?? null;
		},

		/** @internal */
		delete(idHash: string): boolean {
			const result = db.delete(s.authLoginFlows).where(eq(s.authLoginFlows.idHash, idHash)).run();
			return result.changes > 0;
		},

		/** @internal */
		deleteExpired(atIso: string = now()): number {
			const result = db.delete(s.authLoginFlows).where(lt(s.authLoginFlows.expiresAt, atIso)).run();
			return Number(result.changes);
		},
	};
}

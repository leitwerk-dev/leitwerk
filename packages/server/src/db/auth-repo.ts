import type { Actor } from "@leitwerk-dev/domain";
import { and, eq, gt, lt } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { now } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface AuthSessionRecord {
	idHash: string;
	actor: Actor;
	createdAt: string;
	expiresAt: string;
}

export interface AuthLoginFlowRecord {
	idHash: string;
	providerId: string;
	state: string;
	pkceVerifier: string;
	createdAt: string;
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

function flowRowToRecord(row: typeof s.authLoginFlows.$inferSelect): AuthLoginFlowRecord {
	return {
		idHash: row.idHash,
		providerId: row.providerId,
		state: row.state,
		pkceVerifier: row.pkceVerifier,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
	};
}

export function createAuthSessionRepo(db: LeitwerkDb) {
	return {
		create(input: { idHash: string; actor: Actor; expiresAt: string }): AuthSessionRecord {
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

		getValid(idHash: string, atIso: string = now()): AuthSessionRecord | null {
			const row = db
				.select()
				.from(s.authSessions)
				.where(and(eq(s.authSessions.idHash, idHash), gt(s.authSessions.expiresAt, atIso)))
				.get();
			return row ? sessionRowToRecord(row) : null;
		},

		delete(idHash: string): boolean {
			const result = db.delete(s.authSessions).where(eq(s.authSessions.idHash, idHash)).run();
			return result.changes > 0;
		},

		deleteExpired(atIso: string = now()): number {
			const result = db.delete(s.authSessions).where(lt(s.authSessions.expiresAt, atIso)).run();
			return result.changes;
		},
	};
}

export function createAuthLoginFlowRepo(db: LeitwerkDb) {
	return {
		create(input: {
			idHash: string;
			providerId: string;
			state: string;
			pkceVerifier: string;
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
			return flowRowToRecord(values);
		},

		getValid(idHash: string, atIso: string = now()): AuthLoginFlowRecord | null {
			const row = db
				.select()
				.from(s.authLoginFlows)
				.where(and(eq(s.authLoginFlows.idHash, idHash), gt(s.authLoginFlows.expiresAt, atIso)))
				.get();
			return row ? flowRowToRecord(row) : null;
		},

		delete(idHash: string): boolean {
			const result = db.delete(s.authLoginFlows).where(eq(s.authLoginFlows.idHash, idHash)).run();
			return result.changes > 0;
		},

		deleteExpired(atIso: string = now()): number {
			const result = db.delete(s.authLoginFlows).where(lt(s.authLoginFlows.expiresAt, atIso)).run();
			return result.changes;
		},
	};
}

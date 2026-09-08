import type { Actor } from "@leitwerk-dev/domain";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { apiTokens } from "./schema.js";

export type TokenProviderBinding =
	| { id: string; kind: "oidc"; issuer: string; identityClaim: string }
	| { id: string; kind: "oauth2"; organization: string };
export interface ApiTokenOwner {
	kind: "user" | "anonymous";
	id: string;
	actor: Actor;
	providerBinding: TokenProviderBinding | null;
}
export interface ApiTokenRecord {
	id: string;
	prefix: string;
	secretHash: string;
	owner: ApiTokenOwner;
	name: string;
	createdAt: string;
	expiresAt: string | null;
	revokedAt: string | null;
	lastUsedAt: string | null;
}
function record(row: typeof apiTokens.$inferSelect): ApiTokenRecord {
	return {
		id: row.id,
		prefix: row.prefix,
		secretHash: row.secretHash,
		owner: {
			kind: row.ownerKind,
			id: row.ownerId,
			actor: JSON.parse(row.actorJson),
			providerBinding: row.providerBindingJson ? JSON.parse(row.providerBindingJson) : null,
		},
		name: row.name,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		revokedAt: row.revokedAt,
		lastUsedAt: row.lastUsedAt,
	};
}
function owned(owner: ApiTokenOwner) {
	return and(eq(apiTokens.ownerKind, owner.kind), eq(apiTokens.ownerId, owner.id));
}
export function createApiTokenRepo(db: LeitwerkDb) {
	return {
		create(token: ApiTokenRecord): void {
			db.insert(apiTokens)
				.values({
					id: token.id,
					prefix: token.prefix,
					secretHash: token.secretHash,
					ownerKind: token.owner.kind,
					ownerId: token.owner.id,
					actorJson: JSON.stringify(token.owner.actor),
					providerBindingJson: token.owner.providerBinding
						? JSON.stringify(token.owner.providerBinding)
						: null,
					name: token.name,
					createdAt: token.createdAt,
					expiresAt: token.expiresAt,
					revokedAt: token.revokedAt,
					lastUsedAt: token.lastUsedAt,
				})
				.run();
		},
		list(owner: ApiTokenOwner): ApiTokenRecord[] {
			return db
				.select()
				.from(apiTokens)
				.where(owned(owner))
				.orderBy(desc(apiTokens.createdAt))
				.all()
				.map(record);
		},
		findByHash(hash: string): ApiTokenRecord | null {
			const row = db.select().from(apiTokens).where(eq(apiTokens.secretHash, hash)).get();
			return row ? record(row) : null;
		},
		revoke(owner: ApiTokenOwner, id: string, at: string): boolean {
			const filter = and(owned(owner), eq(apiTokens.id, id));
			if (!db.select({ id: apiTokens.id }).from(apiTokens).where(filter).get()) return false;
			db.update(apiTokens)
				.set({ revokedAt: at })
				.where(and(filter, isNull(apiTokens.revokedAt)))
				.run();
			return true;
		},
		revokeAll(owner: ApiTokenOwner, at: string): number {
			const result = db
				.update(apiTokens)
				.set({ revokedAt: at })
				.where(and(owned(owner), isNull(apiTokens.revokedAt)))
				.run();
			return Number(result.changes);
		},
		revokeAnonymous(at: string): number {
			const result = db
				.update(apiTokens)
				.set({ revokedAt: at })
				.where(and(eq(apiTokens.ownerKind, "anonymous"), isNull(apiTokens.revokedAt)))
				.run();
			return Number(result.changes);
		},
		touch(id: string, at: string): void {
			db.update(apiTokens).set({ lastUsedAt: at }).where(eq(apiTokens.id, id)).run();
		},
	};
}

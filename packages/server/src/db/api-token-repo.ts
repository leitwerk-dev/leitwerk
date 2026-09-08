import type { Actor } from "@leitwerk-dev/domain";
import type { ApiTokenMetadata } from "@leitwerk-dev/protocol/http-contracts";
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
export interface ApiTokenRecord extends ApiTokenMetadata {
	secretHash: string;
	owner: ApiTokenOwner;
}
function record(row: typeof apiTokens.$inferSelect): ApiTokenRecord {
	const { ownerKind, ownerId, actorJson, providerBindingJson, ...fields } = row;
	return {
		...fields,
		owner: {
			kind: ownerKind,
			id: ownerId,
			actor: JSON.parse(actorJson),
			providerBinding: providerBindingJson ? JSON.parse(providerBindingJson) : null,
		},
	};
}
function owned(owner: ApiTokenOwner) {
	return and(eq(apiTokens.ownerKind, owner.kind), eq(apiTokens.ownerId, owner.id));
}
export function createApiTokenRepo(db: LeitwerkDb) {
	return {
		create({ owner, ...fields }: ApiTokenRecord): void {
			db.insert(apiTokens)
				.values({
					...fields,
					ownerKind: owner.kind,
					ownerId: owner.id,
					actorJson: JSON.stringify(owner.actor),
					providerBindingJson: owner.providerBinding ? JSON.stringify(owner.providerBinding) : null,
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

import { randomUUID } from "node:crypto";
import { type Actor, ADMIN_ACTOR } from "@leitwerk-dev/domain";
import type { ApiTokenMetadata } from "@leitwerk-dev/protocol/http-contracts";
import type {
	ApiTokenOwner,
	ApiTokenRecord,
	RepositoryBundle,
	TokenProviderBinding,
} from "../db/repositories.js";
import { type ApiTokenPolicy, ApiTokenValidationError, tokenExpiry } from "./api-token-policy.js";
import {
	isActorAllowedByConfig,
	type ResolvedAuthConfig,
	type ResolvedAuthProvider,
} from "./auth-config.js";
import { generateOpaqueToken, hashOpaqueToken } from "./auth-tokens.js";

function binding(provider: ResolvedAuthProvider): TokenProviderBinding {
	return provider.kind === "oidc"
		? {
				id: provider.id,
				kind: provider.kind,
				issuer: provider.issuer,
				identityClaim: provider.identity_claim,
			}
		: { id: provider.id, kind: provider.kind, organization: provider.organization };
}
export function tokenMetadata(token: ApiTokenRecord): ApiTokenMetadata {
	return {
		id: token.id,
		prefix: token.prefix,
		name: token.name,
		createdAt: token.createdAt,
		expiresAt: token.expiresAt,
		revokedAt: token.revokedAt,
		lastUsedAt: token.lastUsedAt,
	};
}
export function createApiTokenService(input: {
	auth: ResolvedAuthConfig;
	policy: ApiTokenPolicy;
	repo: RepositoryBundle["apiTokens"];
}) {
	const { auth, policy, repo } = input;
	// This permanent transition runs even when token issuance/authentication is disabled.
	if (auth.enabled) repo.revokeAnonymous(new Date().toISOString());
	return {
		policy,
		ownerForActor(actor: Actor): ApiTokenOwner {
			if (!auth.enabled)
				return { kind: "anonymous", id: "anonymous", actor: ADMIN_ACTOR, providerBinding: null };
			const provider = auth.providers.find((p) => p.id === actor.provider);
			if (!provider || !isActorAllowedByConfig(actor, auth)) throw new Error("Invalid token owner");
			return { kind: "user", id: actor.id, actor, providerBinding: binding(provider) };
		},
		create(owner: ApiTokenOwner, name: unknown, expiresAt: unknown) {
			if (!policy.enabled) throw new ApiTokenValidationError("API token issuance is disabled");
			if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 100)
				throw new ApiTokenValidationError("Name must contain 1–100 characters");
			const now = Date.now();
			const expiry = tokenExpiry(policy, expiresAt, now);
			const secret = `lwk_pat_${generateOpaqueToken()}`;
			const token: ApiTokenRecord = {
				id: randomUUID(),
				prefix: secret.slice(0, 16),
				secretHash: hashOpaqueToken(secret),
				owner,
				name: name.trim(),
				createdAt: new Date(now).toISOString(),
				expiresAt: expiry,
				revokedAt: null,
				lastUsedAt: null,
			};
			try {
				repo.create(token);
			} catch {
				// Database driver errors can contain bound hashes. Keep them out of HTTP errors and logs.
				throw new Error("Could not save API token");
			}
			return { token: tokenMetadata(token), secret };
		},
		resolve(secret: string): { actor: Actor | null; token: ApiTokenRecord | null } {
			if (!/^lwk_pat_[A-Za-z0-9_-]{43}$/.test(secret)) return { actor: null, token: null };
			let token: ApiTokenRecord | null;
			try {
				token = repo.findByHash(hashOpaqueToken(secret));
			} catch {
				throw new Error("Could not resolve API token");
			}
			if (!token) return { actor: null, token: null };
			const denied = { actor: null, token };
			const now = new Date().toISOString();
			if (
				!policy.enabled ||
				token.revokedAt ||
				(token.expiresAt !== null && token.expiresAt <= now)
			)
				return denied;
			if (token.owner.kind === "anonymous") {
				if (auth.enabled) return denied;
			} else {
				if (!auth.enabled || !isActorAllowedByConfig(token.owner.actor, auth)) return denied;
				const provider = auth.providers.find((p) => p.id === token.owner.actor.provider);
				if (
					!provider ||
					JSON.stringify(binding(provider)) !== JSON.stringify(token.owner.providerBinding)
				)
					return denied;
			}
			repo.touch(token.id, now);
			return { actor: token.owner.kind === "anonymous" ? ADMIN_ACTOR : token.owner.actor, token };
		},
		list: (owner: ApiTokenOwner) => repo.list(owner).map(tokenMetadata),
		revoke: (owner: ApiTokenOwner, id: string) => repo.revoke(owner, id, new Date().toISOString()),
		revokeAll: (owner: ApiTokenOwner) => repo.revokeAll(owner, new Date().toISOString()),
	};
}
export type ApiTokenService = ReturnType<typeof createApiTokenService>;

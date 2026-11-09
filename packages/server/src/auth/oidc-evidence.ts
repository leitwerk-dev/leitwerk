import type { Actor } from "@leitwerk-dev/domain";
import type { UserInformationResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import type { OidcAccessPolicy } from "../config/config-types.js";
import type { ResolvedAuthProvider, ResolvedOidcProvider } from "./auth-config.js";
import type { GithubOauthClient } from "./github-oauth-client.js";
import type { OidcTokensAndClaims } from "./oidc-client.js";

/** Session/token evidence, never attached to an Actor. @internal */
export interface OidcEvidence extends UserInformationResponseBody {
	/** @internal */
	identityClaim: string;
}

/** Exclude credential-shaped claims even when returned by a custom provider. */
function safeClaims(claims: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(
		JSON.stringify(claims, (key, value) =>
			/^(access_token|refresh_token|id_token|client_secret|authorization)$/i.test(key)
				? undefined
				: value,
		),
	);
}

function mergedClaims(
	evidence: Pick<OidcEvidence, "idTokenClaims" | "userInfoClaims">,
): Record<string, unknown> {
	return { ...evidence.idTokenClaims, ...evidence.userInfoClaims };
}

function actorFromClaims(provider: ResolvedAuthProvider, claims: Record<string, unknown>): Actor {
	const rawIdentity = claims[provider.identity_claim];
	const identity = typeof rawIdentity === "string" ? rawIdentity.trim() : "";
	if (!identity) {
		throw new Error(`Authentication identity claim ${provider.identity_claim} was not present`);
	}
	const displayName =
		[claims.name, claims.preferred_username, claims.email].find(
			(value): value is string => typeof value === "string" && value.trim() !== "",
		) ?? identity;
	return {
		id: `${provider.id}:${identity}`,
		kind: "user",
		provider: provider.id,
		displayName,
	};
}

/** @internal */
export function interpretLogin(
	provider: ResolvedOidcProvider,
	exchange: OidcTokensAndClaims,
): { actor: Actor; oidcEvidence: OidcEvidence };
/** @internal */
export function interpretLogin(
	provider: Exclude<ResolvedAuthProvider, ResolvedOidcProvider>,
	exchange: Awaited<ReturnType<GithubOauthClient["exchangeCallback"]>>,
): { actor: Actor; oidcEvidence: null };
export function interpretLogin(
	provider: ResolvedAuthProvider,
	exchange: OidcTokensAndClaims | Awaited<ReturnType<GithubOauthClient["exchangeCallback"]>>,
): { actor: Actor; oidcEvidence: OidcEvidence | null } {
	if ("claims" in exchange) {
		return { actor: actorFromClaims(provider, exchange.claims), oidcEvidence: null };
	}
	if (provider.kind !== "oidc") throw new Error("Invalid OIDC provider");
	const idTokenClaims = safeClaims(exchange.idTokenClaims);
	const userInfoClaims = exchange.userInfoClaims ? safeClaims(exchange.userInfoClaims) : null;
	if (
		typeof idTokenClaims.sub !== "string" ||
		!idTokenClaims.sub.trim() ||
		(userInfoClaims && userInfoClaims.sub !== idTokenClaims.sub)
	)
		throw new Error("Invalid OIDC subject evidence");
	const claims = mergedClaims({ idTokenClaims, userInfoClaims });
	const actor = actorFromClaims(provider, claims);
	const groups = claims[provider.access?.groups_claim ?? "groups"];
	return {
		actor,
		oidcEvidence: {
			providerId: provider.id,
			issuer: provider.issuer,
			identityClaim: provider.identity_claim,
			subject: idTokenClaims.sub,
			loginAt: new Date().toISOString(),
			idTokenClaims,
			userInfoClaims,
			facts: {
				identity: actor.id.slice(provider.id.length + 1),
				email: typeof claims.email === "string" ? claims.email : null,
				emailVerified: claims.email_verified === true,
				groups:
					Array.isArray(groups) && groups.every((group) => typeof group === "string") ? groups : [],
			},
		},
	};
}

function validDomain(domain: string): boolean {
	return (
		domain.length <= 253 &&
		domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
	);
}

/** @internal */
export function policyErrors(policy: OidcAccessPolicy, legacy: boolean): string[] {
	const errors: string[] = [];
	if (legacy) errors.push("cannot combine access with deprecated auth.allowlist");
	const lists = [policy.users, policy.groups, policy.email_domains];
	if (
		policy.mode === "all" &&
		(lists.some((list) => list !== undefined) ||
			policy.match !== undefined ||
			policy.groups_claim !== undefined)
	)
		errors.push("access mode all cannot include restrictions, match, or groups_claim");
	if (policy.mode === "restricted" && !lists.some((list) => list && list.length > 0))
		errors.push("restricted access requires at least one non-empty criterion");
	if (
		lists.some(
			(list) => list !== undefined && (list.length === 0 || list.some((item) => !item.trim())),
		)
	)
		errors.push("access criteria must be non-empty lists of non-empty strings");
	if (policy.email_domains?.some((domain) => !validDomain(domain)))
		errors.push("access email_domains must contain exact domain names");
	return errors;
}

/** @internal */
export function evidenceAllows(
	actor: Actor,
	provider: ResolvedOidcProvider,
	evidence: OidcEvidence | null | undefined,
	allowlist: Set<string>,
): boolean {
	if (
		!evidence ||
		evidence.providerId !== provider.id ||
		evidence.issuer !== provider.issuer ||
		evidence.identityClaim !== provider.identity_claim ||
		typeof evidence.subject !== "string" ||
		!evidence.subject.trim() ||
		evidence.idTokenClaims.sub !== evidence.subject ||
		(evidence.userInfoClaims !== null && evidence.userInfoClaims.sub !== evidence.subject)
	)
		return false;
	const claims = mergedClaims(evidence);
	const identity =
		typeof claims[provider.identity_claim] === "string"
			? (claims[provider.identity_claim] as string).trim()
			: "";
	if (!identity || actor.id !== `${provider.id}:${identity}`) return false;
	const policy = provider.access;
	if (!policy) return allowlist.has(identity);
	if (policy.mode === "all") return true;
	const matches: boolean[] = [];
	if (policy.users) matches.push(policy.users.includes(identity));
	if (policy.groups) {
		const groups = claims[policy.groups_claim ?? "groups"];
		matches.push(
			Array.isArray(groups) &&
				groups.every((group) => typeof group === "string") &&
				policy.groups.some((group) => groups.includes(group)),
		);
	}
	if (policy.email_domains) {
		const email = claims.email;
		const domain =
			typeof email === "string" && /^[^\s@]+@[^\s@]+$/.test(email)
				? email.split("@")[1]?.toLowerCase()
				: undefined;
		matches.push(
			claims.email_verified === true &&
				domain !== undefined &&
				validDomain(domain) &&
				policy.email_domains.some((allowed) => allowed.toLowerCase() === domain),
		);
	}
	return (
		matches.length > 0 && (policy.match === "any" ? matches.some(Boolean) : matches.every(Boolean))
	);
}

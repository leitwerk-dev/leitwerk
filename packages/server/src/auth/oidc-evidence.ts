import type { Actor } from "@leitwerk-dev/domain";
import type { OidcAccessPolicy } from "../config/config-types.js";
import type { ResolvedOidcProvider } from "./auth-config.js";

/** Session/token evidence, never attached to an Actor. @internal */
export interface OidcEvidence {
	/** @internal */
	providerId: string;
	/** @internal */
	issuer: string;
	/** @internal */
	identityClaim: string;
	/** @internal */
	subject: string;
	/** @internal */
	loginAt: string;
	/** @internal */
	idTokenClaims: Record<string, unknown>;
	/** @internal */
	userInfoClaims: Record<string, unknown> | null;
	/** @internal */
	facts: {
		/** @internal */
		identity: string;
		/** @internal */
		email: string | null;
		/** @internal */
		emailVerified: boolean;
		/** @internal */
		groups: string[];
	};
}

/** Exclude credential-shaped claims even when returned by a custom provider. @internal */
export function safeClaims(claims: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(
		JSON.stringify(claims, (key, value) =>
			/^(access_token|refresh_token|id_token|client_secret|authorization)$/i.test(key)
				? undefined
				: value,
		),
	);
}

/** @internal */
export function mergedClaims(evidence: OidcEvidence): Record<string, unknown> {
	return { ...evidence.idTokenClaims, ...evidence.userInfoClaims };
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

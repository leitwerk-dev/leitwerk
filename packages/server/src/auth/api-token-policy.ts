import type { ApiTokenPolicy } from "@leitwerk-dev/protocol/http-contracts";

export type { ApiTokenPolicy } from "@leitwerk-dev/protocol/http-contracts";

import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { ApiTokensConfig } from "../config/config-types.js";

export function resolveApiTokenPolicy(config?: ApiTokensConfig): ApiTokenPolicy {
	const duration = (value: string, key: string): number => {
		const ms = parseDurationMs(value, -1, { allowHours: true });
		if (!Number.isSafeInteger(ms) || ms <= 0)
			throw new Error(`auth.api_tokens.${key} must be a positive duration`);
		return ms;
	};
	const defaultTtlMs = duration(config?.default_ttl ?? "7d", "default_ttl");
	const maxTtlMs = duration(config?.max_ttl ?? "90d", "max_ttl");
	if (defaultTtlMs > maxTtlMs)
		throw new Error("auth.api_tokens.default_ttl must not exceed max_ttl");
	return {
		enabled: config?.enabled ?? true,
		defaultTtlMs,
		maxTtlMs,
		allowNoExpiry: config?.allow_no_expiry ?? true,
	};
}
export class ApiTokenValidationError extends Error {}

export function tokenExpiry(
	policy: ApiTokenPolicy,
	expiresAt: unknown,
	now: number,
): string | null {
	if (expiresAt === null) {
		if (!policy.allowNoExpiry) throw new ApiTokenValidationError("No expiration is not allowed");
		return null;
	}
	if (expiresAt === undefined) return new Date(now + policy.defaultTtlMs).toISOString();
	// Require an absolute ISO date-time. Date.parse alone accepts surprising inputs such as "1".
	if (
		typeof expiresAt !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(expiresAt)
	)
		throw new ApiTokenValidationError("expiresAt must be an ISO date-time");
	const datePart = expiresAt.slice(0, 10);
	if (
		!Number.isFinite(Date.parse(`${datePart}T00:00:00Z`)) ||
		new Date(`${datePart}T00:00:00Z`).toISOString().slice(0, 10) !== datePart
	)
		throw new ApiTokenValidationError("Invalid expiration date");
	const ms = Date.parse(expiresAt);
	if (!Number.isFinite(ms) || ms <= now || ms > now + policy.maxTtlMs)
		throw new ApiTokenValidationError(
			"Expiration must be in the future and within the maximum TTL",
		);
	return new Date(ms).toISOString();
}

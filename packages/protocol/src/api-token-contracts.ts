/** @internal */
export interface ApiTokenMetadata {
	/** @internal */
	id: string;
	/** @internal */
	prefix: string;
	/** @internal */
	name: string;
	/** @internal */
	createdAt: string;
	/** @internal */
	expiresAt: string | null;
	/** @internal */
	revokedAt: string | null;
	/** @internal */
	lastUsedAt: string | null;
}
/** @internal */
export interface ApiTokenPolicy {
	/** @internal */
	enabled: boolean;
	/** @internal */
	defaultTtlMs: number;
	/** @internal */
	maxTtlMs: number;
	/** @internal */
	allowNoExpiry: boolean;
}
/** @internal */
export interface ApiTokensResponseBody {
	/** @internal */
	tokens: ApiTokenMetadata[];
	/** @internal */
	policy: ApiTokenPolicy;
	/** @internal */
	csrfToken: string;
}
/** @internal */
export interface CreateApiTokenResponseBody {
	/** @internal */
	token: ApiTokenMetadata;
	/** @internal */
	secret: string;
}

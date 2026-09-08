export interface ApiTokenMetadata {
	id: string;
	prefix: string;
	name: string;
	createdAt: string;
	expiresAt: string | null;
	revokedAt: string | null;
	lastUsedAt: string | null;
}
export interface ApiTokenPolicy {
	enabled: boolean;
	defaultTtlMs: number;
	maxTtlMs: number;
	allowNoExpiry: boolean;
}
export interface ApiTokensResponseBody {
	tokens: ApiTokenMetadata[];
	policy: ApiTokenPolicy;
	csrfToken: string;
}
export interface CreateApiTokenResponseBody {
	token: ApiTokenMetadata;
	secret: string;
}

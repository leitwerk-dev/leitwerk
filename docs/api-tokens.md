# API token HTTP API

Application requests accept one `Authorization: Bearer lwk_pat_…` header without
a session cookie. A token acts as its owner across application HTTP endpoints,
including reads, immediate actions, model changes, and schedules. Existing
application gates still apply. Never put the token in a URL.

Management uses browser access: a valid session when authentication is enabled,
or shared anonymous access when disabled. Every management route rejects
Authorization credentials and returns `Cache-Control: no-store`, including errors.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/auth/tokens` | `{ tokens, policy, csrfToken }` for the current owner |
| POST | `/api/auth/tokens` | `201 { token, secret }`; the secret is returned once |
| DELETE | `/api/auth/tokens/:id` | `{ ok: true }`; another owner's ID returns 404 |
| DELETE | `/api/auth/tokens` | `{ ok: true, count }` for owner-wide revocation |

POST accepts `{ name, expiresAt? }`. Names contain 1–100 characters after trimming.
Omitting `expiresAt` uses the default TTL; an ISO timestamp requests dated expiry;
`null` requests no expiration. Unknown fields, including caller-selected owner or
provider fields, return 400. Disabled issuance returns 403.

Metadata contains `id`, `prefix`, `name`, `createdAt`, `expiresAt`, `revokedAt`, and
`lastUsedAt`. Nullable expiry means no expiration. Metadata excludes hashes and
secrets. Policy contains `enabled`, `defaultTtlMs`, `maxTtlMs`, and `allowNoExpiry`.

First GET the management resource, preserving browser cookies. Send its
`csrfToken` as `X-CSRF-Token` on every mutation, together with an Origin exactly
matching `server.base_url`'s origin. Missing or invalid Origin/CSRF returns 403.
Authenticated CSRF is session-bound; anonymous CSRF uses a separate browser
cookie and does not split anonymous ownership. Authentication failures return 401.

For rotation, create a replacement, update the client, verify a request such as
`GET /api/auth/me`, and revoke the old ID. Revoked or expired tokens return 401 on
subsequent requests; logout alone does not revoke tokens. See
[security](security.md#personal-and-anonymous-api-tokens) for binding, storage,
audit outcomes, and compatible rollback.

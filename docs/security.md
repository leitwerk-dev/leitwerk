# Security & Authentication Boundaries

This document defines security boundaries, authentication models, and credential handling in Leitwerk. Read this page to understand how user authentication works, how secrets are encrypted in SQLite, and how container isolation protects worker execution.

---

## 1. Authentication Models

- **Web Authentication:** Disabled by default (`auth.enabled: false`). When enabled (`auth.enabled: true`), OIDC authenticates allowlisted identities via PKCE or native GitHub OAuth authenticates active members of one configured organization. Leitwerk stores only hashed session tokens in SQLite. Authentication applies globally (no per-process authorization or multi-tenant isolation).
- **Worker Authentication:** Workers authenticate via lease-scoped WebSocket connect tokens and bearer snapshot tokens (`PUT /session-snapshot`). Tokens are bound to the active process lease and hashed server-side.

---

## 2. Secrets & Container Isolation

- **SQLite Secret Encryption:** Provider credentials stored in SQLite are encrypted using a 32-byte application key (`LEITWERK_CREDENTIAL_ENCRYPTION_KEY`). Raw secrets never appear in logs, process state, or session tree files.
- **Container Isolation:** Docker and Kubernetes container runtimes provide the production security boundary. Workers operate in isolated environments without direct database access.
- **Frontend Sanitization:** Browser markdown rendering uses DOMPurify to sanitize HTML and block XSS constructs before inserting content into the Chronicle view.

## Personal and anonymous API tokens

API tokens authenticate as their owner for application HTTP APIs, including
`/api/auth/me`. They grant the same application access as the owner's browser
session. There are no token-specific repository or action grants. Existing
process validation, model selection, action gates, scheduling, and actor
attribution still apply.

Send exactly one `Authorization: Bearer lwk_pat_…` header, without a session
cookie. Malformed, duplicate, unknown, expired, revoked, or ambiguous credentials
are rejected without fallback, including when authentication is disabled.
Tokens in query parameters, request bodies, or cookies do not authenticate.
Browser WebSockets, token management, OAuth, and worker credentials remain
separate authentication flows.

With authentication enabled, token ownership comes from the current valid
GitHub or OIDC session, including sessions created before upgrading. User tokens
bind to their issuing provider ID and kind, OIDC issuer and identity claim, or
GitHub organization. Removing or changing that identity configuration blocks
the token. OIDC tokens also use the current allowlist. GitHub membership is
checked at login, matching session behavior; issuance and bearer requests make
no additional membership requests. Provider secrets are never part of the binding.
Logout ends the browser session; it does not revoke tokens.

With authentication disabled, every visitor manages one shared anonymous owner.
Anonymous HTTP operations retain the existing admin actor for attribution. Each
browser receives its own CSRF cookie, but this does not create a separate owner.
User tokens cannot authenticate in this mode. Every startup with authentication
enabled permanently revokes anonymous tokens, even if token support is disabled.
Turning authentication off again does not revive them.

SQLite stores a public ID, display prefix, SHA-256 secret hash, explicit owner,
provider binding, name, and lifecycle timestamps. The 32-byte random secret uses
the `lwk_pat_` prefix and appears only in the creation response. Token management
responses, including errors, use `Cache-Control: no-store`. Secrets never enter
process state, worker inputs, browser persistence, or audit records. The UI holds
a new secret only until dismissal or leaving the page; explicit copy writes it
to the user's clipboard.

Management mutations require the exact configured application Origin and a
CSRF token bound to the browser session (or separate anonymous CSRF cookie).
The management GET supplies that CSRF context. Cookies retain HttpOnly, SameSite
Lax, and Secure on HTTPS. Bearer credentials cannot manage tokens.

Structured `api_token_audit` records capture issuance, revocation, and final
bearer request outcomes with request ID, timestamp, operation, actor/owner and
public token ID when known, status, and process/action route identifiers. Unknown
credentials have no trusted token ID. Credential headers, secret hashes, and
secret response bodies are excluded.

Revocation blocks subsequent authentication. Accepted work and schedules retain
their lifecycle and owner attribution; stop them through existing operations.
To rotate, create a replacement, update the client, verify access, then revoke
the old token.

### Migration and rollback

Startup backs up file-backed SQLite and applies the explicit
`20260908_add_api_tokens` migration atomically. Existing sessions, processes, and
encrypted credentials survive. To disable the feature, retain this binary and
set `auth.api_tokens.enabled: false`. Listing and revocation remain available.
The old binary rejects the new schema; reverting the binary is not a compatible
rollback. Do not restore an old database to disable tokens, as that loses later
process data.

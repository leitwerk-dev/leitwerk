# Security

## Configure OIDC login

Enable browser sign-in on a running deployment with an HTTPS reverse proxy. You need an OIDC issuer and an account whose username the provider returns in `preferred_username`.

Register a confidential OIDC client with your provider. Set the callback URL to your public Leitwerk origin plus `/auth/callback`, for example `https://leitwerk.example.com/auth/callback`.

In `leitwerk.yaml`, set `server.base_url` to that same public origin and add this `auth` block. Replace the issuer, client ID, and allowed username with your values.

```yaml
auth:
  enabled: true
  providers:
    - id: company
      kind: oidc
      issuer: https://identity.example.com
      client_id: leitwerk
      client_secret: "${LEITWERK_OIDC_CLIENT_SECRET}"
      access:
        mode: restricted
        users: [alice]
```

Supply `LEITWERK_OIDC_CLIENT_SECRET` to the server process through your deployment's secret configuration and restart Leitwerk. Include an admission policy. Omitting both `access` and the legacy allowlist leaves everyone locked out.

Open the public URL in a private browser window. Confirm Leitwerk shows **Sign in required**. Select **Sign in**, authenticate with the allowed account, and confirm you return to the dashboard. Open your user menu and choose **User information** to verify the recorded OIDC identity.

If the provider rejects the callback URL, compare its registration against `server.base_url` and the `/auth/callback` path. If Leitwerk rejects the login, check that the account's identity claim matches an entry in `access.users`. See [Configuration reference](configuration.md#server-authentication-and-transport) for claim and policy options.

## Who can access what

Authentication grants application-wide access. Leitwerk does not provide per-process permissions or tenant isolation. Workers and repository code are semi-trusted: credential routing is not isolation from code running as the same OS user. Configure network exposure and worker privileges accordingly.

[Topic solution wikis](../users/solution-wiki.md) and non-secret [scoped settings](../users/settings.md) share this application-wide access model and actor attribution. Agent wiki tools use server-pinned topic bindings; evidence and agent-authored guidance are untrusted, and tombstones prevent same-ID resurrection only (not recall from active contexts or audit history).

## Authentication boundaries

| Boundary | Credential and scope |
| --- | --- |
| Browser | One configured OIDC or native GitHub provider when `auth.enabled: true`. Session tokens are hashed in SQLite. |
| Application HTTP API | Browser session or owner-equivalent API token; existing process and action gates still apply. |
| Worker IPC | Lease-scoped WebSocket connect token and snapshot bearer token, hashed server-side and bound to the active lease. |
| Local session transfer | Expiring (1h), process-bound bearer grant and claim attempt, separate from browser cookies. |

Browser WebSockets enforce session and origin checks. Application API tokens, worker credentials, and session-transfer grants are never interchangeable.

### Login and session behavior {#oidc-and-github-login}

Authentication is disabled by default. Anonymous requests attribute actions to the built-in admin actor.

- **OIDC**: Uses PKCE and the configured `access` policy (or deprecated `auth.allowlist`). Login requires a valid ID-token subject, and UserInfo must match that subject when returned; if UserInfo is unavailable, ID-token claims must still satisfy admission. Sessions and API tokens evaluate current policy against retained last-login claims, so provider-side membership changes require re-login and token replacement. SQLite stores claims separately from actors and retains no access, refresh, or raw ID tokens or client secrets; protect SQLite files and backups as personal information. `GET /api/auth/user-information` requires an OIDC session cookie, rejects Bearer tokens, and sends `Cache-Control: no-store`.
- **GitHub**: Requires active membership in one configured organization (`read:org`). Membership is checked at login; sessions and API tokens do not re-poll GitHub on each request.

## API tokens {#api-tokens}

Personal (or anonymous, when `auth.enabled: false`) API tokens authenticate application HTTP requests as their owner using exactly one `Authorization: Bearer lwk_pat_...` header with no session cookie. Malformed, duplicate, unknown, expired, revoked, or ambiguous credentials fail with `401` without fallback. Query, body, and cookie tokens are ignored. For creating and rotating tokens in the UI, see [API tokens](../users/api-tokens.md).

### Ownership, storage, and audit

- **Binding**: User tokens bind to the issuing provider ID/kind and OIDC issuer/identity claim or GitHub organization; changing identity configuration invalidates existing tokens. Logout ends the browser session, not its API tokens.
- **Anonymous mode**: All visitors share one anonymous owner. Every startup with `auth.enabled: true` permanently revokes anonymous tokens (even if `auth.api_tokens.enabled: false`); disabling auth later does not revive them.
- **Storage**: SQLite stores public ID, prefix, SHA-256 hash of the 32-byte secret, binding, name, and lifecycle timestamps. The raw secret is returned once on creation and never stored in process state, worker inputs, or logs.
- **Audit**: Structured `api_token_audit` records capture issuance, revocation, and request outcomes (request ID, timestamp, operation, actor/owner, known public token ID, status, and route identifiers), excluding headers, hashes, and secret bodies.
- **Disabling**: Set `auth.api_tokens.enabled: false` to block issuance and Bearer auth while retaining listing and revocation. Never roll back to an older database backup solely to disable tokens.

### Management HTTP API

Management routes require browser access (session cookie when auth is enabled, or anonymous access when disabled), reject `Authorization` headers, and return `Cache-Control: no-store` on all responses including errors.

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/api/auth/tokens` | `{ tokens, policy, csrfToken }` for the current owner |
| `POST` | `/api/auth/tokens` | `201 { token, secret }` (secret shown once) |
| `DELETE` | `/api/auth/tokens/:id` | `{ ok: true }` (`404` for another owner's ID) |
| `DELETE` | `/api/auth/tokens` | `{ ok: true, count }` (owner-wide revocation) |

`POST` accepts `{ name, expiresAt? }` (trimmed `name` 1–100 chars; omitted `expiresAt` uses `default_ttl`, ISO timestamp requests dated expiry within `max_ttl`, `null` requests no expiry when allowed; unknown fields return `400`, disabled issuance returns `403`).

Every mutation (`POST`, `DELETE`) requires:

1. An `Origin` header exactly matching `server.base_url`'s origin.
2. `X-CSRF-Token` matching the `csrfToken` from `GET /api/auth/tokens`, bound to the browser session cookie (or a separate anonymous CSRF cookie).

Missing or invalid Origin/CSRF returns `403`; auth failures return `401`. Cookies use `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS.

## Secrets and transport

### Encrypted provider credentials

`provider_credentials` in SQLite are encrypted with AES-256-GCM using `LEITWERK_CREDENTIAL_ENCRYPTION_KEY` (Base64 of 32 bytes). Omitting the key fails startup whenever `provider_credentials` is non-empty or configured providers attempt to seed credentials. Keep the key paired with database backups. Model resource snapshots are immutable and non-secret; credentials are delivered separately per physical worker start with mode `0600`, and workers never import `~/.pi/agent` or repository Pi files.

### Internal TLS

Public UI/API HTTPS is terminated by a reverse proxy in front of the server. Optional `internal_tls` secures only the worker-to-server IPC listener:

- Set `internal_tls.enabled: true`, `cert_file`, and `key_file`.
- Switch `docker.server_url` or `kubernetes.server_url` to `https://` and set the corresponding `server_ca_file`.
- Worker client certificates are not supported; `internal_tls.client_ca_file` is rejected at startup.

### HTTPS repository authentication {#https-repository-authentication}

Owning extensions authorize an HTTPS origin and the server narrows credentials to the exact project repository URL (rejecting userinfo, query strings, fragments, and ambiguous paths). Credentials travel only in authenticated `worker.start`, live outside checkouts in a `0700` temp directory (`0600` files), and are removed on shutdown or failed bootstrap. A single-repo Git credential helper answers only `get` for the exact host, port, and path; tokens never enter clone URLs, argv, Git config, or ordinary tool environments.

### Docker registry credentials {#docker-registry-credentials}

Operator-owned `docker_registries.process_bindings` deliver credentials only to code-defined `runtime.docker` processes, resolved fresh per physical start (never selectable from process params). Workers write an ephemeral `0700`/`0600` `config.json` exposed via `DOCKER_CONFIG` and `HELM_REGISTRY_CONFIG`, delete it on exit or failed bootstrap, and keep it outside process volumes and exports. Bindings govern delivery, not registry-side permissions.

## Subprocess, content, and isolation boundaries

Model-profile requirements constrain managed LLM calls, including title generation. They do not provide tenant isolation or network sandboxing and do not constrain networking by trusted extensions or tools. Operators own classification labels; provider capability metadata is a catalog assertion, not a security certification.

- **Subprocess environments**: Ordinary worker subprocesses and pre-launch repository lookups run in a sanitized environment that strips worker/provider credentials, Git/SSH/askpass variables, and managed helpers; overrides cannot restore stripped variables. Project Git operations add only that project's trusted credentials.
- **Repository toolchains (`mise`)**: Opted-in `mise` configs and plugins execute as trusted repository code. Initial installation runs before managed Pi credentials are materialized; later invocations omit known credentials from child environments but share the worker filesystem and OS user. Authenticated private tool sources are unsupported.
- **Content and evidence**: Browser Markdown is sanitized with DOMPurify. Execution inspection redacts known delivered provider, repository, and registry secrets before IPC and marks redacted fields, but raw tool output and `diagnostic-traces/` can still contain workspace secrets—protect them accordingly.
- **Container and sandbox isolation**: Local workers run as the host OS user. For Docker private-daemon isolation (`privileged` vs `sysbox-runc`), see [Docker deployment](deploy-docker.md#private-docker-inside-workers). For Kubernetes `RuntimeClass`, `gvisor`, `virtual-machine`, and `hostUsers` boundaries, see [Kubernetes deployment](deploy-kubernetes.md#private-docker-workers). For local session-transfer grants and isolated export helpers, see [Process workspace](../maintainers/process-workspace.md).

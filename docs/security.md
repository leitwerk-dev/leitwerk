# Security and authentication

Authentication grants application-wide access. Leitwerk does not provide per-process
permissions or tenant isolation. Workers and repository code are semi-trusted;
credential routing is not isolation from code running as the same OS user.
Configure network exposure and worker privileges accordingly.

## Authentication models {#1-authentication-models}

| Boundary | Credential and scope |
| --- | --- |
| Browser | One configured OIDC or native GitHub provider when authentication is enabled. Session tokens are hashed in SQLite. |
| Application HTTP API | Browser access or an owner-equivalent API token; existing action and process gates still apply. |
| Worker | Lease-scoped WebSocket connect token and snapshot bearer token. Both are hashed server-side and bound to the active lease. |
| Local session transfer | Expiring, process-bound bearer grant and claim attempt, separate from browser cookies. |

Authentication is disabled by default. Enabled OIDC uses PKCE and allowlisted
identity claims; native GitHub OAuth requires active membership in one configured
organization. See [configuration](configuration.md#server-authentication-and-transport).

Browser WebSockets require their own session/origin checks. Application API tokens,
worker credentials, and transfer grants are not interchangeable.

## Secrets and isolation {#2-secrets-container-isolation}

### Stored credentials

Provider credentials in SQLite are encrypted with
`LEITWERK_CREDENTIAL_ENCRYPTION_KEY`, the Base64 encoding of exactly 32 bytes.
Preserve the key/database pairing in protected backups. Managed credential payloads
are excluded from process state, session trees, and credential diagnostics.
Raw tool output may still contain sensitive data; protect diagnostic traces.

Model resource snapshots are immutable and non-secret. The current credential layer
is delivered separately for each physical worker. Workers never import ambient Pi
files or repository Pi extensions, prompts, or skills.

### Worker authority

Local workers run as the host user. Docker and Kubernetes provide the production
container boundary, subject to selected runtime privileges. The Docker-backed server
controls the host engine socket; do not treat that server as an unprivileged workload.

Private Docker under the Docker runner requires either privileged mode, with broad
host-kernel authority, or an installed `sysbox-runc` runtime. Kubernetes uses the
operator-configured RuntimeClass and `hostUsers`. It does not add privileged mode,
host paths, host namespaces, a host runtime socket, or a TCP Docker listener.

Explicit gVisor mode omits `hostUsers`, adds SYS_ADMIN and NET_ADMIN inside the
sandbox, and uses the verified Docker wrapper. Select a verified runsc node. Only
Docker-requiring process namespaces receive the Pod Security `privileged` admission
label; their worker remains non-privileged. Other Kubernetes modes add no capabilities.
The Helm chart generates the admission policy.

### Repository code and browser content

Opted-in mise configuration and plugins are trusted repository code. Initial tool
installation precedes managed Pi credential materialization. Later preparation
omits known credentials from the child environment but shares the worker filesystem
and OS identity; this is not credential isolation. Authenticated private tool sources
are unsupported. Mise output is retained verbatim in diagnostic traces.

Browser Markdown uses DOMPurify to sanitize HTML before rendering. Treat external
text, model output, and destination prompt context as untrusted data, not instructions
for server configuration or authorization.

## Local session transfers

An authenticated web operator may create a one-hour bearer grant for a process with
a primary session. The raw token appears in the URL fragment and server responses;
SQLite stores only its SHA-256 hash. Transfer routes bypass cookie authentication
but are bound to the exact origin, process, grant, and attempt.

Non-loopback links require HTTPS. Redirects are rejected. Link origins come from
`server.base_url`, not request headers. Anyone holding the link may download the
retained workspace and conversation; delivered bytes cannot be recalled.

Export accepts regular files, directories, and relative symlinks confined to the
workspace. It excludes managed credential directories and unrelated process-volume
paths. This does not redact secrets that repository code or an operator wrote into
workspace files or conversation text. Both peers enforce entry and byte limits;
local import verifies compressed SHA-256 before committing.

Isolated export helpers receive non-secret manifest/limit data and one random export
credential. The server stores only its hash, binds it to a live attempt, permits one
stream, and rechecks attempt liveness and deadline. Helpers receive no worker, model,
repository, or container-engine credential.

Docker named-volume and Kubernetes PVC helpers mount only `workspace/` and `tree/`
read-only, plus an optional server CA. Pi-agent and tooling directories are not
mounted. Helpers wait for an active client before uploading. Docker scoped mounts
require Engine 26.0 / API 1.45 or newer; unsupported engines fail without a full-volume
fallback. See [transfer storage](process-workspace.md#5-local-pi-session-transfer).

## Personal and anonymous API tokens

Tokens authenticate as their owner across application HTTP APIs, including
`/api/auth/me`. They grant the same access as the owner's browser session, with no
token-specific repository or action grants. Process validation, model selection,
action gates, scheduling, and attribution still apply.

Send exactly one `Authorization: Bearer lwk_pat_…` header without a session cookie.
Malformed, duplicate, unknown, expired, revoked, or ambiguous credentials reject
without fallback, including with authentication disabled. Query, body, and cookie
tokens do not authenticate. Browser WebSockets, token management, OAuth, and worker
credentials remain separate flows.

### Ownership and provider changes

With authentication enabled, a valid GitHub or OIDC session establishes ownership,
including sessions created before upgrading. User tokens bind to the issuing provider
ID/kind and OIDC issuer/identity claim or GitHub organization. Changing that identity
configuration blocks the token. OIDC also checks the current allowlist.

GitHub membership is checked at login, matching session behavior. Token issuance and
bearer requests make no additional membership requests. Provider secrets are not part
of the binding. Logout ends the browser session, not its API tokens.

With authentication disabled, all visitors manage one anonymous owner. Anonymous HTTP
operations retain the admin actor. Each browser has its own CSRF cookie, but not a
separate owner. User tokens cannot authenticate in this mode. Every authentication-enabled
startup permanently revokes anonymous tokens, even if token support is disabled.
Turning authentication off again does not revive them.

### Storage, management, and audit

SQLite stores a public ID, prefix, SHA-256 secret hash, owner/provider binding, name,
and lifecycle timestamps. The 32-byte random secret uses `lwk_pat_` and appears only
in the creation response. Management responses, including errors, use
`Cache-Control: no-store`. Secrets do not enter process state, worker inputs, browser
persistence, or audit records. Explicit copying writes the secret to the user's clipboard.

Management mutations require the configured application Origin and a CSRF token bound
to the browser session or anonymous cookie. Management GET establishes that context.
Cookies use HttpOnly, SameSite Lax, and Secure on HTTPS. Bearer credentials cannot
manage tokens. See the [HTTP reference](api-tokens.md).

Structured `api_token_audit` records retain issuance, revocation, and final request
outcomes with request ID, time, operation, actor/owner, known public token ID, status,
and process/action route identifiers. Unknown credentials have no trusted token ID.
Headers, secret hashes, and secret response bodies are excluded.

Revocation blocks subsequent authentication; it does not cancel accepted work or
schedules. Rotate by creating a replacement, updating and verifying the client, then
revoking the old token.

### Disable token access

Set `auth.api_tokens.enabled: false` to disable issuance and bearer authentication
while retaining listing and revocation. Keep a schema-compatible binary. Restoring
an old database to disable tokens loses later process data. See the
[backup procedure](operations.md).

## HTTPS repository authentication

The provider authorizes an HTTPS origin; the server narrows it to the exact project
repository URL. Userinfo, query strings, fragments, and ambiguous paths are rejected.
Fresh credentials travel only in authenticated `worker.start`, separately from
non-secret snapshots. Bootstrap verifies process declarations and project snapshots.

Credential files live outside checkouts in a 0700 temporary directory, with mode 0600.
The Git helper answers only `get` for the exact host, port, and repository path.
Trusted Git resets helper configuration, enables path matching, disables redirects,
and disallows other transports. Tokens never appear in clone URLs, argv, Git config,
or ordinary tool environments. Credentials are removed on worker shutdown or failed
bootstrap. As with SSH, this is routing within a semi-trusted worker, not same-user isolation.

## Docker registry credentials

[Operator-owned bindings](configuration.md#docker-registry-credentials) select
credentials for code-defined Docker-requiring processes, never from process params.
Bindings govern delivery, not registry permissions. Each physical start resolves
current credentials through authenticated IPC.

Workers use a private ephemeral `config.json` (directory 0700, file 0600) through
`DOCKER_CONFIG`. Buildx metadata remains under the tooling root. Shutdown or failed
bootstrap removes credentials. IPC diagnostics redact credential values and encoded
auth. Credential payloads are removed from retained bootstrap state, and credential
directories are outside process volumes and exports.

## Subprocess environments

`sanitizeWorkerSubprocessEnv(baseEnv?, overrides?)` filters ordinary worker subprocess
and pre-launch repository lookup environments after applying overrides. Overrides
cannot restore stripped worker/provider credentials, Git settings, SSH/askpass
variables, or managed helpers. `repositoryGitSubprocessEnv(projectKey)` adds only
the selected project's trusted Git credentials to that sanitized environment.

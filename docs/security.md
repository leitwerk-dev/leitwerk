# Security & Authentication Boundaries

This document defines security boundaries, authentication models, and credential handling in Leitwerk. Read this page to understand how user authentication works, how secrets are encrypted in SQLite, and how container isolation protects worker execution.

---

## 1. Authentication Models

- **Web Authentication:** Disabled by default (`auth.enabled: false`). When enabled (`auth.enabled: true`), OIDC authenticates allowlisted identities via PKCE or native GitHub OAuth authenticates active members of one configured organization. Leitwerk stores only hashed session tokens in SQLite. Authentication applies globally (no per-process authorization or multi-tenant isolation).
- **Worker Authentication:** Workers authenticate via lease-scoped WebSocket connect tokens and bearer snapshot tokens (`PUT /session-snapshot`). Tokens are bound to the active process lease and hashed server-side.
- **Local Session Transfer:** An authenticated web operator can mint a one-hour bearer grant for a process with a primary session. The raw token appears only in the URL fragment and server responses; SQLite stores its SHA-256 hash. Bearer routes bypass cookie authentication but are bound to the exact origin, process, grant, and attempt. Non-loopback links require HTTPS, redirects are rejected, and generated origins come from `server.base_url` rather than request headers.

---

## 2. Secrets & Container Isolation

- **SQLite Secret Encryption:** Provider credentials stored in SQLite are encrypted using a 32-byte application key (`LEITWERK_CREDENTIAL_ENCRYPTION_KEY`). Raw secrets never appear in logs, process state, or session tree files.
- **Container Isolation:** Docker and Kubernetes container runtimes provide the production security boundary. Workers operate in isolated environments without direct database access. Kubernetes private-Docker Pods use only the operator-configured RuntimeClass and `hostUsers`; Leitwerk does not add privileged mode, host paths, host namespaces, capabilities, a node runtime socket, or a TCP Docker listener.
- **Transfer Scope:** Export preflight is root-confined and accepts only regular files, directories, and relative symlinks that remain inside the workspace. Archives exclude provider, repository, Pi-agent, and runner credentials. Both peers enforce entry, logical-byte, and compressed-byte limits; local Pi verifies the final compressed SHA-256 before committing.
- **Isolated Export Helpers:** Docker named-volume and Kubernetes PVC helpers receive only non-secret manifest and limit data plus one random export credential. The server keeps its SHA-256 hash, binds it to one live attempt, accepts one stream, and rechecks lease and deadline state on every helper request. Helpers mount only the process volume's `workspace/` and `tree/` directories read-only, plus an optional read-only server CA certificate. Pi-agent state and other process-volume directories are not mounted. Helpers receive no worker connection, model, provider, Forgejo, repository, Docker, or Kubernetes API credential, and wait for an active client stream before uploading. Docker named-volume exports require Engine 26.0 or newer (API 1.45+) for scoped volume mounts; unsupported APIs fail without a full-volume fallback.
- **Repository Tool Configuration:** Opted-in mise configuration and plugins are trusted repository code. Initial installation precedes managed Pi credential materialization. Later preparation omits known credentials from the child environment but shares the worker filesystem and OS identity; it is not credential isolation. Authenticated private tool sources are unsupported. Mise output is stored verbatim in server diagnostic trace files and must be treated as sensitive.
- **Frontend Sanitization:** Browser markdown rendering uses DOMPurify to sanitize HTML and block XSS constructs before inserting content into the Chronicle view.

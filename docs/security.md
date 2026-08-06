# Security & Authentication Boundaries

This document defines security boundaries, authentication models, and credential handling in Leitwerk. Read this page to understand how user authentication works, how secrets are encrypted in SQLite, and how container isolation protects worker execution.

---

## 1. Authentication Models

- **Web Authentication:** Disabled by default (`auth.enabled: false`). When enabled (`auth.enabled: true`), OIDC authenticates allowlisted users via PKCE, storing hashed session tokens in SQLite. Authentication applies to all allowlisted users globally (no per-process authorization or multi-tenant isolation).
- **Worker Authentication:** Workers authenticate via lease-scoped WebSocket connect tokens and bearer snapshot tokens (`PUT /session-snapshot`). Tokens are bound to the active process lease and hashed server-side.

---

## 2. Secrets & Container Isolation

- **SQLite Secret Encryption:** Provider credentials stored in SQLite are encrypted using a 32-byte application key (`LEITWERK_CREDENTIAL_ENCRYPTION_KEY`). Raw secrets never appear in logs, process state, or session tree files.
- **Container Isolation:** Docker and Kubernetes container runtimes provide the production security boundary. Workers operate in isolated environments without direct database access.
- **Frontend Sanitization:** Browser markdown rendering uses DOMPurify to sanitize HTML and block XSS constructs before inserting content into the Chronicle view.

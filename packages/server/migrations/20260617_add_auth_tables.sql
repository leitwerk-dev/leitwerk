-- Adds server-side SSO session and login-flow storage.
-- Apply to configured storage.sqlite_path before starting code that expects
-- Forgejo/OIDC authentication tables. Existing auth-disabled installations do
-- not need row backfills because these tables are new.

CREATE TABLE IF NOT EXISTS auth_sessions (
	id_hash text PRIMARY KEY NOT NULL,
	actor_id text NOT NULL,
	actor_provider text,
	display_name text,
	created_at text NOT NULL,
	expires_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_actor ON auth_sessions(actor_id);

CREATE TABLE IF NOT EXISTS auth_login_flows (
	id_hash text PRIMARY KEY NOT NULL,
	provider_id text NOT NULL,
	state text NOT NULL,
	pkce_verifier text NOT NULL,
	created_at text NOT NULL,
	expires_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_login_flows_expires ON auth_login_flows(expires_at);

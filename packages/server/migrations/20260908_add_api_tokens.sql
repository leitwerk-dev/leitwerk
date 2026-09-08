-- Applied atomically after a file-backed SQLite backup. No existing rows change.
CREATE TABLE api_tokens (
 id text PRIMARY KEY NOT NULL,
 prefix text NOT NULL,
 secret_hash text NOT NULL,
 owner_kind text NOT NULL,
 owner_id text NOT NULL,
 actor_json text NOT NULL,
 provider_binding_json text,
 name text NOT NULL,
 created_at text NOT NULL,
 expires_at text,
 revoked_at text,
 last_used_at text
);
CREATE UNIQUE INDEX idx_api_tokens_secret_hash ON api_tokens (secret_hash);
CREATE INDEX idx_api_tokens_owner ON api_tokens (owner_kind, owner_id);

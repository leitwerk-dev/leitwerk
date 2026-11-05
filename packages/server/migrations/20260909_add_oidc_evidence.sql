-- Legacy OIDC credentials lack admission evidence and must reauthenticate.
ALTER TABLE auth_sessions ADD COLUMN oidc_evidence_json text;
ALTER TABLE api_tokens ADD COLUMN oidc_evidence_json text;

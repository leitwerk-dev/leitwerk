-- Removes the obsolete provider-owned credential schema version.
-- Credential payloads remain encrypted and retain their provider id, revision,
-- and timestamps.

ALTER TABLE provider_credentials
	RENAME TO provider_credentials_before_20260724;

CREATE TABLE provider_credentials (
	provider_id text PRIMARY KEY NOT NULL,
	revision integer NOT NULL,
	encrypted_payload text NOT NULL,
	created_at text NOT NULL,
	updated_at text NOT NULL,
	CONSTRAINT provider_credentials_positive_revision CHECK ("provider_credentials"."revision" > 0)
);

INSERT INTO provider_credentials (
	provider_id,
	revision,
	encrypted_payload,
	created_at,
	updated_at
)
SELECT
	provider_id,
	revision,
	encrypted_payload,
	created_at,
	updated_at
FROM provider_credentials_before_20260724;

DROP TABLE provider_credentials_before_20260724;

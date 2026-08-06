-- Adds durable idempotency for cross-process handoffs.
-- Apply to configured storage.sqlite_path before starting code that expects this table.

CREATE TABLE IF NOT EXISTS process_handoff_dedup_keys (
	key text PRIMARY KEY,
	instance_id text NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE,
	created_at text NOT NULL,
	metadata text NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_handoff_dedup_keys_instance
	ON process_handoff_dedup_keys(instance_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_handoff_dedup_keys_instance
	ON process_handoff_dedup_keys(instance_id);

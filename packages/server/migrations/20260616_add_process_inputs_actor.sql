-- Adds durable actor attribution to queued process inputs.
-- Apply to configured storage.sqlite_path before starting code that expects this column.
--
-- The column is NOT NULL with a SYSTEM_ACTOR default so existing rows backfill
-- to the system principal, matching the runtime fallback for un-attributed inputs.

ALTER TABLE process_inputs
	ADD COLUMN actor text NOT NULL DEFAULT '{"id":"system","kind":"system","provider":null}';

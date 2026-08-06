-- Rewrite durable extension identifiers for the Leitwerk alpha namespace.
-- Run only while the server is stopped and after backing up the SQLite file.

UPDATE process_leaf_outcome_snapshots
SET renderer_id = replace(renderer_id, '@orchestrator-v2/', '@leitwerk-dev/')
WHERE renderer_id LIKE '@orchestrator-v2/%';

UPDATE process_inputs
SET kind = replace(kind, '@orchestrator-v2/', '@leitwerk-dev/')
WHERE kind LIKE '@orchestrator-v2/%';

UPDATE pending_external_source_fires
SET source_kind = replace(source_kind, '@orchestrator-v2/', '@leitwerk-dev/')
WHERE source_kind LIKE '@orchestrator-v2/%';

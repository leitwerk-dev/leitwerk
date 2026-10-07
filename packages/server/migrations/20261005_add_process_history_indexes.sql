CREATE INDEX IF NOT EXISTS idx_turn_records_page ON turn_records(instance_id, started_at, id);
CREATE INDEX IF NOT EXISTS idx_turn_annotations_created ON turn_annotations(instance_id, created_at);
CREATE INDEX IF NOT EXISTS idx_worker_leases_started ON worker_leases(instance_id, started_at);
CREATE INDEX IF NOT EXISTS idx_worker_leases_exited ON worker_leases(instance_id, exited_at);
DROP INDEX IF EXISTS idx_leaf_outcomes_anchored;

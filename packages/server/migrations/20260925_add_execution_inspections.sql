CREATE TABLE inspection_contents (
  digest text PRIMARY KEY NOT NULL,
  content_json text NOT NULL
);
CREATE TABLE execution_inspections (
  sequence integer PRIMARY KEY NOT NULL,
  id text NOT NULL,
  instance_id text NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE,
  turn_record_id text NOT NULL REFERENCES turn_records(id) ON DELETE CASCADE,
  start_record_id text NOT NULL,
  worker_lease_id text NOT NULL,
  captured_at text NOT NULL,
  fact_json text NOT NULL
);
CREATE INDEX idx_execution_inspections_turn ON execution_inspections(instance_id, turn_record_id);
CREATE UNIQUE INDEX idx_execution_inspections_id ON execution_inspections(id);

-- Preserve legacy ingestion order, even when event timestamps are equal.
BEGIN IMMEDIATE;
CREATE TEMP TABLE staged_reasoning_events AS SELECT rowid AS event_sequence, * FROM process_events;
DROP TABLE process_events;
CREATE TABLE process_events (
 id text PRIMARY KEY NOT NULL,
 instance_id text NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE,
 event_type text NOT NULL,
 data text NOT NULL DEFAULT '{}',
 created_at text NOT NULL,
 event_sequence integer NOT NULL,
 turn_record_id text
);
INSERT INTO process_events (id, instance_id, event_type, data, created_at, event_sequence, turn_record_id)
 SELECT id, instance_id, event_type, data, created_at, event_sequence, json_extract(data, '$.turnRecordId') FROM staged_reasoning_events;
DROP TABLE staged_reasoning_events;
CREATE INDEX idx_process_events_instance ON process_events(instance_id);
CREATE INDEX idx_process_events_instance_created ON process_events(instance_id, created_at);
CREATE INDEX idx_process_events_instance_sequence ON process_events(instance_id, event_sequence);
CREATE INDEX idx_process_events_type ON process_events(event_type);
CREATE UNIQUE INDEX uq_process_events_sequence ON process_events(event_sequence);
CREATE INDEX idx_process_events_turn_sequence ON process_events(instance_id, turn_record_id, event_sequence);
CREATE INDEX idx_process_events_turn_type_sequence ON process_events(instance_id, turn_record_id, event_type, event_sequence);
CREATE INDEX idx_process_events_instance_type_sequence ON process_events(instance_id, event_type, event_sequence);
CREATE TABLE turn_summaries (
 turn_record_id text PRIMARY KEY NOT NULL,
 instance_id text NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE,
 summary_json text NOT NULL
);
CREATE INDEX idx_turn_summaries_instance ON turn_summaries(instance_id);
CREATE TABLE session_summaries (
 instance_id text PRIMARY KEY NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE,
 summary_json text NOT NULL
);
COMMIT;
-- The server backfills derived summaries at startup, outside page requests.

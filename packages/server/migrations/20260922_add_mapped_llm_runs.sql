-- Durable sequential mapped LLM turns: one run per turn entry, one row per frozen item.
BEGIN IMMEDIATE;
ALTER TABLE turn_records ADD COLUMN mapped_run_id text;
ALTER TABLE turn_records ADD COLUMN mapped_item_key text;
ALTER TABLE turn_records ADD COLUMN mapped_item_index integer;
ALTER TABLE turn_start_records ADD COLUMN mapped_run_id text;
ALTER TABLE turn_start_records ADD COLUMN mapped_item_key text;
ALTER TABLE turn_start_records ADD COLUMN mapped_item_index integer;
CREATE TABLE mapped_llm_runs (
 id text PRIMARY KEY NOT NULL,
 instance_id text NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE,
 turn_id text NOT NULL,
 status text NOT NULL,
 item_count integer NOT NULL,
 next_index integer NOT NULL,
 created_at text NOT NULL,
 updated_at text NOT NULL,
 CONSTRAINT mapped_llm_runs_status CHECK ("mapped_llm_runs"."status" in ('active', 'completed', 'aborted')),
 CONSTRAINT mapped_llm_runs_progress CHECK ("mapped_llm_runs"."item_count" >= 0 and "mapped_llm_runs"."next_index" >= 0 and "mapped_llm_runs"."next_index" <= "mapped_llm_runs"."item_count")
);
CREATE INDEX idx_mapped_llm_runs_instance ON mapped_llm_runs(instance_id);
CREATE UNIQUE INDEX uq_mapped_llm_runs_active_instance ON mapped_llm_runs(instance_id) WHERE "mapped_llm_runs"."status" = 'active';
CREATE TABLE mapped_llm_items (
 run_id text NOT NULL REFERENCES mapped_llm_runs(id) ON DELETE CASCADE,
 instance_id text NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE,
 item_index integer NOT NULL,
 item_key text NOT NULL,
 label text NOT NULL,
 item_json text NOT NULL,
 status text NOT NULL DEFAULT 'pending',
 outcome text,
 result_json text,
 turn_record_id text,
 completed_at text,
 CONSTRAINT mapped_llm_items_status CHECK ("mapped_llm_items"."status" in ('pending', 'completed')),
 CONSTRAINT mapped_llm_items_item_json CHECK (json_valid("mapped_llm_items"."item_json")),
 CONSTRAINT mapped_llm_items_result CHECK (("mapped_llm_items"."status" = 'pending' and "mapped_llm_items"."result_json" is null) or ("mapped_llm_items"."status" = 'completed' and "mapped_llm_items"."result_json" is not null and json_valid("mapped_llm_items"."result_json")))
);
CREATE UNIQUE INDEX uq_mapped_llm_items_run_index ON mapped_llm_items(run_id, item_index);
CREATE UNIQUE INDEX uq_mapped_llm_items_run_key ON mapped_llm_items(run_id, item_key);
CREATE INDEX idx_mapped_llm_items_instance ON mapped_llm_items(instance_id);
COMMIT;

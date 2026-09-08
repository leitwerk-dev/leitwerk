CREATE TABLE launch_runs (
  id text PRIMARY KEY NOT NULL,
  idempotency_key text UNIQUE,
  launcher_id text,
  origin text NOT NULL,
  instance_id text REFERENCES process_instances(id) ON DELETE CASCADE,
  status text NOT NULL,
  steps_json text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  completed_at text,
  revision integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_launch_runs_instance ON launch_runs(instance_id);
CREATE INDEX idx_launch_runs_idempotency_key ON launch_runs(idempotency_key);
CREATE INDEX idx_launch_runs_status ON launch_runs(status);
CREATE TABLE launch_run_replays (
  launch_run_id text PRIMARY KEY NOT NULL REFERENCES launch_runs(id) ON DELETE CASCADE,
  payload_json text NOT NULL
);
ALTER TABLE process_title_jobs ADD COLUMN launch_run_id text REFERENCES launch_runs(id) ON DELETE SET NULL;
CREATE INDEX idx_process_title_jobs_launch_run ON process_title_jobs(launch_run_id);

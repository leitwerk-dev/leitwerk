ALTER TABLE skills ADD COLUMN registration_kind text NOT NULL DEFAULT 'configuration';
CREATE TABLE skill_catalog_entries (repository_id text NOT NULL, skill_id text NOT NULL, label text NOT NULL, description text, source_path text NOT NULL, source_revision text NOT NULL, bundle_digest text NOT NULL, bundle_bytes blob NOT NULL, discovered_at text NOT NULL, available integer NOT NULL DEFAULT true);
CREATE UNIQUE INDEX uq_skill_catalog_entry ON skill_catalog_entries (repository_id, skill_id);
CREATE INDEX idx_skill_catalog_skill ON skill_catalog_entries (skill_id);
CREATE TABLE skill_invocations (instance_id text NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE, turn_record_id text NOT NULL, skill_id text NOT NULL REFERENCES skills(id), skill_revision_id text NOT NULL REFERENCES skill_revisions(id), invoked_at text NOT NULL);
CREATE UNIQUE INDEX uq_skill_invocation_turn_skill ON skill_invocations (turn_record_id, skill_id);
CREATE INDEX idx_skill_invocations_skill_time ON skill_invocations (skill_id, invoked_at);

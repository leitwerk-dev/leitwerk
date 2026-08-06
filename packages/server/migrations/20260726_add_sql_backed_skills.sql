-- Applied atomically by packages/server/src/db/database.ts after a file backup.
CREATE TABLE skills (id text PRIMARY KEY NOT NULL, label text NOT NULL, description text, active_revision_id text, created_at text NOT NULL, updated_at text NOT NULL, CONSTRAINT fk_skills_active_revision FOREIGN KEY (active_revision_id) REFERENCES skill_revisions(id));
CREATE TABLE skill_revisions (id text PRIMARY KEY NOT NULL, skill_id text NOT NULL REFERENCES skills(id), bundle_digest text NOT NULL, bundle_bytes blob NOT NULL, source_revision text, imported_at text NOT NULL);
CREATE UNIQUE INDEX uq_skill_revisions_skill_digest ON skill_revisions (skill_id, bundle_digest);
CREATE TABLE process_skills (instance_id text NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE, skill_id text NOT NULL REFERENCES skills(id), skill_revision_id text NOT NULL REFERENCES skill_revisions(id), position integer NOT NULL);
CREATE UNIQUE INDEX uq_process_skills_instance_skill ON process_skills (instance_id, skill_id);
CREATE UNIQUE INDEX uq_process_skills_instance_position ON process_skills (instance_id, position);

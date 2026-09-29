CREATE TABLE settings_subjects (
 id text PRIMARY KEY NOT NULL,
 scope_type text NOT NULL,
 identity text NOT NULL,
 label text NOT NULL,
 context_json text NOT NULL,
 schema_version integer NOT NULL,
 revision integer NOT NULL,
 created_at text NOT NULL,
 updated_at text NOT NULL,
 actor_json text NOT NULL
);
CREATE UNIQUE INDEX uq_settings_subject_identity ON settings_subjects(scope_type, identity);
CREATE TABLE settings_aliases (
 alias text PRIMARY KEY NOT NULL,
 subject_id text NOT NULL REFERENCES settings_subjects(id)
);
CREATE TABLE settings_overrides (
 subject_id text NOT NULL REFERENCES settings_subjects(id),
 key text NOT NULL,
 value_json text NOT NULL,
 mode text NOT NULL,
 reset integer NOT NULL,
 schema_version integer NOT NULL,
 revision integer NOT NULL,
 created_at text NOT NULL,
 updated_at text NOT NULL,
 actor_json text NOT NULL
);
CREATE UNIQUE INDEX uq_settings_override ON settings_overrides(subject_id, key);

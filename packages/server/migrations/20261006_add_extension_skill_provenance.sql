-- Applied atomically after a file-backed SQLite backup.
ALTER TABLE skills ADD COLUMN owner_extension_id text;
ALTER TABLE skill_revisions ADD COLUMN provenance_json text;

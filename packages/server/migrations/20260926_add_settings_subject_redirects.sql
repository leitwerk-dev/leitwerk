CREATE TABLE settings_subject_redirects (
 subject_id text PRIMARY KEY NOT NULL REFERENCES settings_subjects(id),
 canonical_subject_id text NOT NULL REFERENCES settings_subjects(id)
);

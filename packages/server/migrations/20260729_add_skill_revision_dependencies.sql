CREATE TABLE skill_revision_dependencies (skill_revision_id text NOT NULL REFERENCES skill_revisions(id) ON DELETE CASCADE, dependency_skill_id text NOT NULL, position integer NOT NULL);
CREATE UNIQUE INDEX uq_skill_revision_dependency ON skill_revision_dependencies (skill_revision_id, dependency_skill_id);
CREATE UNIQUE INDEX uq_skill_revision_dependency_position ON skill_revision_dependencies (skill_revision_id, position);

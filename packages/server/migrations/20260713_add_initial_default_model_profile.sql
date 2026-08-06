-- Retains the effective process default model as it was resolved at creation time.
ALTER TABLE process_instances ADD COLUMN initial_default_model_profile_id text;

-- Explicit launch defaults are exact historical values. Older inherited defaults
-- cannot be reconstructed safely and remain NULL.
UPDATE process_instances
SET initial_default_model_profile_id = default_model_profile_id
WHERE initial_default_model_profile_id IS NULL;

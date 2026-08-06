ALTER TABLE process_instances ADD COLUMN selected_turn_model_kind text;
ALTER TABLE future_executions ADD COLUMN model_profile_id text;
ALTER TABLE future_executions ADD COLUMN model_selection_kind text;
ALTER TABLE future_executions ADD COLUMN model_selection_source text;
ALTER TABLE future_executions ADD COLUMN blocked_reason_json text;
ALTER TABLE turn_records ADD COLUMN model_selection_kind text;
ALTER TABLE turn_records ADD COLUMN model_selection_source text;

UPDATE process_instances SET
  selected_turn_model_kind = CASE
    WHEN selected_turn_model_profile_id IS NULL THEN NULL
    WHEN selected_turn_model_source IN ('action_override','instance_turn_config','instance_default') THEN 'explicit'
    ELSE 'inherited' END,
  selected_turn_model_source = CASE
    WHEN selected_turn_model_profile_id IS NOT NULL
      AND (selected_turn_model_source IS NULL OR selected_turn_model_source NOT IN ('action_override','instance_turn_config','process_config_turn','instance_default','process_config_default','catalog_default'))
      THEN 'legacy_persisted'
    ELSE selected_turn_model_source END;

UPDATE turn_records
SET model_selection_kind = 'inherited', model_selection_source = 'legacy_persisted'
WHERE model_profile_id IS NOT NULL;

-- Persists the resolution path used when freezing the selected-turn model.
-- Existing rows cannot be reconstructed safely and remain NULL.
ALTER TABLE process_instances ADD COLUMN selected_turn_model_source text;

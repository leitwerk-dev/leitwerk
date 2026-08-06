CREATE TABLE IF NOT EXISTS process_launch_intents (
	instance_id text PRIMARY KEY NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE,
	launcher_id text NOT NULL,
	launcher_input_json text NOT NULL,
	selected_skill_ids_json text NOT NULL
);

ALTER TABLE process_instances ADD COLUMN launch_intent_json text;

UPDATE process_instances
SET launch_intent_json = (
	SELECT json_object(
		'launcherId', launcher_id,
		'launcherInput', json(launcher_input_json),
		'selectedSkillIds', json(selected_skill_ids_json)
	)
	FROM process_launch_intents
	WHERE instance_id = process_instances.id
)
WHERE launch_intent_json IS NULL
	AND id IN (SELECT instance_id FROM process_launch_intents);

DROP TABLE process_launch_intents;

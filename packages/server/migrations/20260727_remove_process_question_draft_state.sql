ALTER TABLE process_question_requests
RENAME TO process_question_requests_before_20260727;

CREATE TABLE process_question_requests (
	id text PRIMARY KEY NOT NULL,
	instance_id text NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE,
	turn_record_id text NOT NULL,
	tool_call_id text NOT NULL,
	questions_json text NOT NULL,
	status text NOT NULL DEFAULT 'open',
	answers_json text,
	asked_at text NOT NULL,
	answered_at text,
	answered_by_json text,
	cancelled_at text,
	CONSTRAINT question_requests_status CHECK ("process_question_requests"."status" in ('open', 'answered', 'cancelled')),
	CONSTRAINT question_requests_questions_json CHECK (json_valid("process_question_requests"."questions_json")),
	CONSTRAINT question_requests_answers_json CHECK ("process_question_requests"."answers_json" is null or json_valid("process_question_requests"."answers_json")),
	CONSTRAINT fk_question_requests_turn FOREIGN KEY (instance_id, turn_record_id) REFERENCES turn_records(instance_id, id)
);

INSERT INTO process_question_requests
	(id, instance_id, turn_record_id, tool_call_id, questions_json, status,
	 answers_json, asked_at, answered_at, answered_by_json, cancelled_at)
SELECT id, instance_id, turn_record_id, tool_call_id, questions_json, status,
	answers_json, asked_at, answered_at, answered_by_json, cancelled_at
FROM process_question_requests_before_20260727;

DROP TABLE process_question_requests_before_20260727;

CREATE UNIQUE INDEX uq_question_requests_turn_tool
ON process_question_requests(instance_id, turn_record_id, tool_call_id);
CREATE INDEX idx_question_requests_instance_status
ON process_question_requests(instance_id, status);

BEGIN;
SELECT pg_advisory_xact_lock(765274821);

CREATE SCHEMA IF NOT EXISTS mailflow;
CREATE TABLE IF NOT EXISTS mailflow.schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM mailflow.schema_migrations WHERE version = 1) THEN
    RETURN;
  END IF;

  CREATE TABLE mailflow.workflow_runs (
    id uuid PRIMARY KEY,
    account_key text NOT NULL CHECK (account_key ~ '^[A-Za-z0-9_-]{1,128}$'),
    batch_hash text NOT NULL CHECK (batch_hash ~ '^[0-9a-f]{64}$'),
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, account_key)
  );

  CREATE TABLE mailflow.messages (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_key text NOT NULL CHECK (account_key ~ '^[A-Za-z0-9_-]{1,128}$'),
    gmail_message_id text NOT NULL CHECK (
      char_length(gmail_message_id) <= 256 AND gmail_message_id ~ '^[A-Za-z0-9_-]+$'
    ),
    received_at timestamptz,
    first_processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (account_key, gmail_message_id),
    UNIQUE (id, account_key)
  );

  CREATE TABLE mailflow.classifications (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_key text NOT NULL,
    message_id bigint NOT NULL,
    run_id uuid NOT NULL,
    category text NOT NULL CHECK (category ~ '^[a-z][a-z0-9_]{0,63}$'),
    status text NOT NULL CHECK (status ~ '^[a-z][a-z0-9_]{0,63}$'),
    matched_rule_ids text[] NOT NULL CHECK (
      cardinality(matched_rule_ids) <= 100 AND array_position(matched_rule_ids, NULL) IS NULL
      AND array_to_string(matched_rule_ids, ',') ~ '^([a-z][a-z0-9_]{0,63}(,[a-z][a-z0-9_]{0,63})*)?$'
    ),
    explanation_codes text[] NOT NULL CHECK (
      cardinality(explanation_codes) <= 100 AND array_position(explanation_codes, NULL) IS NULL
      AND array_to_string(explanation_codes, ',') ~ '^([a-z][a-z0-9_]{0,63}(,[a-z][a-z0-9_]{0,63})*)?$'
    ),
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (message_id, account_key) REFERENCES mailflow.messages (id, account_key),
    FOREIGN KEY (run_id, account_key) REFERENCES mailflow.workflow_runs (id, account_key),
    UNIQUE (run_id, message_id)
  );

  CREATE TABLE mailflow.policy_decisions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    classification_id bigint NOT NULL UNIQUE REFERENCES mailflow.classifications (id),
    action text NOT NULL CHECK (action IN ('immediate', 'daily', 'weekly', 'none')),
    status text NOT NULL CHECK (status ~ '^[a-z][a-z0-9_]{0,63}$'),
    explanation_codes text[] NOT NULL CHECK (
      cardinality(explanation_codes) <= 100 AND array_position(explanation_codes, NULL) IS NULL
      AND array_to_string(explanation_codes, ',') ~ '^([a-z][a-z0-9_]{0,63}(,[a-z][a-z0-9_]{0,63})*)?$'
    ),
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );

  CREATE TABLE mailflow.action_log (
    id uuid PRIMARY KEY,
    account_key text NOT NULL,
    message_id bigint NOT NULL,
    action_type text NOT NULL CHECK (action_type ~ '^[a-z][a-z0-9_]{0,63}$'),
    outcome text NOT NULL CHECK (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (message_id, account_key) REFERENCES mailflow.messages (id, account_key)
  );

  INSERT INTO mailflow.schema_migrations (version) VALUES (1);
END
$migration$;

COMMIT;

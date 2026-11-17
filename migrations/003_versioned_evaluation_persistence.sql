BEGIN;
SELECT pg_advisory_xact_lock(765274821);

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mailflow.schema_migrations WHERE version = 2) THEN
    RAISE EXCEPTION 'Historical ingestion migration is required';
  END IF;
  IF EXISTS (SELECT 1 FROM mailflow.schema_migrations WHERE version = 3) THEN
    RETURN;
  END IF;

  CREATE TABLE mailflow.account_configuration_revisions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_key text NOT NULL CHECK (account_key ~ '^[A-Za-z0-9_-]{1,128}$'),
    request_id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    snapshot jsonb NOT NULL CHECK (
      jsonb_typeof(snapshot) = 'object'
      AND snapshot ? 'policyOverrides'
      AND jsonb_typeof(snapshot->'policyOverrides') = 'object'
      AND snapshot ? 'tagDefinitions'
      AND jsonb_typeof(snapshot->'tagDefinitions') = 'array'
    ),
    digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (account_key, request_id),
    UNIQUE (account_key, version),
    UNIQUE (id, account_key, version, digest)
  );

  CREATE TABLE mailflow.versioned_evaluation_batches (
    id uuid PRIMARY KEY,
    account_key text NOT NULL CHECK (account_key ~ '^[A-Za-z0-9_-]{1,128}$'),
    batch_hash text NOT NULL CHECK (batch_hash ~ '^[0-9a-f]{64}$'),
    is_historical_replay boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, account_key)
  );

  CREATE TABLE mailflow.evaluations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id uuid NOT NULL,
    account_key text NOT NULL,
    message_id bigint NOT NULL,
    schema_version text NOT NULL CHECK (schema_version = '1.0'),
    classification jsonb NOT NULL CHECK (
      jsonb_typeof(classification) = 'object'
      AND classification ?& ARRAY[
        'schemaVersion', 'category', 'status', 'matchedRuleIds', 'explanationCodes'
      ]
      AND classification->>'schemaVersion' = '1.0'
      AND jsonb_typeof(classification->'category') = 'string'
      AND jsonb_typeof(classification->'status') = 'string'
      AND jsonb_typeof(classification->'matchedRuleIds') = 'array'
      AND jsonb_typeof(classification->'explanationCodes') = 'array'
      AND classification - ARRAY[
        'schemaVersion', 'category', 'status', 'matchedRuleIds', 'explanationCodes'
      ] = '{}'::jsonb
    ),
    policy jsonb NOT NULL CHECK (
      jsonb_typeof(policy) = 'object'
      AND policy ?& ARRAY[
        'schemaVersion', 'category', 'priority', 'notificationEligible',
        'notificationCadence', 'recommendedAction', 'action', 'explanationCodes', 'status'
      ]
      AND policy->>'schemaVersion' = '2.0'
      AND policy->>'category' IN (
        'application_rejection', 'interview_request', 'screening_request',
        'application_confirmation', 'application_update', 'job_alert',
        'recruiter_contact', 'other'
      )
      AND policy->>'priority' IN ('high', 'normal', 'low', 'unset')
      AND policy->>'notificationEligible' IN ('true', 'false')
      AND jsonb_typeof(policy->'notificationEligible') = 'boolean'
      AND policy->>'notificationCadence' IN ('immediate', 'daily', 'weekly', 'none')
      AND policy->>'recommendedAction' IN ('review', 'respond', 'reference', 'none')
      AND policy->>'action' IN ('immediate', 'daily', 'weekly', 'none')
      AND jsonb_typeof(policy->'status') = 'string'
      AND policy->>'status' IN (
        'decided', 'insufficient_evidence', 'invalid_configuration',
        'invalid_tagging', 'invalid_classification', 'unsupported_classification',
        'invalid_input'
      )
      AND jsonb_typeof(policy->'explanationCodes') = 'array'
      AND policy - ARRAY[
        'schemaVersion', 'category', 'priority', 'notificationEligible',
        'notificationCadence', 'recommendedAction', 'action', 'explanationCodes', 'status'
      ] = '{}'::jsonb
      AND (
        (policy->>'notificationEligible' = 'true'
          AND policy->>'notificationCadence' IN ('immediate', 'daily', 'weekly')
          AND policy->>'action' = policy->>'notificationCadence')
        OR
        (policy->>'notificationEligible' = 'false'
          AND policy->>'notificationCadence' = 'none'
          AND policy->>'action' = 'none')
      )
      AND (
        policy->>'priority' <> 'unset'
        OR (
          policy->>'category' = 'other'
          AND policy->>'notificationEligible' = 'false'
          AND policy->>'recommendedAction' = 'none'
        )
      )
    ),
    configuration_revision_id bigint,
    configuration_version integer,
    configuration_digest text,
    built_in_defaults_version text NOT NULL CHECK (
      built_in_defaults_version ~ '^[A-Za-z0-9._-]{1,64}$'
    ),
    is_historical_replay boolean NOT NULL,
    evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
      (configuration_revision_id IS NULL
        AND configuration_version IS NULL
        AND configuration_digest IS NULL)
      OR
      (configuration_revision_id IS NOT NULL
        AND configuration_version IS NOT NULL
        AND configuration_digest IS NOT NULL
        AND configuration_digest ~ '^sha256:[0-9a-f]{64}$')
    ),
    FOREIGN KEY (batch_id, account_key)
      REFERENCES mailflow.versioned_evaluation_batches (id, account_key),
    FOREIGN KEY (message_id, account_key)
      REFERENCES mailflow.messages (id, account_key),
    FOREIGN KEY (
      configuration_revision_id,
      account_key,
      configuration_version,
      configuration_digest
    ) REFERENCES mailflow.account_configuration_revisions (id, account_key, version, digest),
    UNIQUE (batch_id, message_id),
    UNIQUE (id, account_key, message_id)
  );

  CREATE TABLE mailflow.evaluation_tag_assignments (
    evaluation_id bigint NOT NULL,
    account_key text NOT NULL,
    message_id bigint NOT NULL,
    tag_id text NOT NULL CHECK (tag_id ~ '^[a-z][a-z0-9_]{0,63}$'),
    provenance_type text NOT NULL CHECK (
      provenance_type IN ('built_in_rule', 'user_correction')
    ),
    provenance_reference text NOT NULL CHECK (
      provenance_reference ~ '^[A-Za-z0-9_-]{1,128}$'
    ),
    PRIMARY KEY (evaluation_id, tag_id),
    FOREIGN KEY (evaluation_id, account_key, message_id)
      REFERENCES mailflow.evaluations (id, account_key, message_id)
  );

  CREATE TABLE mailflow.current_effective_evaluations (
    account_key text NOT NULL,
    message_id bigint NOT NULL,
    evaluation_id bigint NOT NULL,
    selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (account_key, message_id),
    FOREIGN KEY (message_id, account_key)
      REFERENCES mailflow.messages (id, account_key),
    FOREIGN KEY (evaluation_id, account_key, message_id)
      REFERENCES mailflow.evaluations (id, account_key, message_id)
  );

  CREATE TABLE mailflow.tag_corrections (
    sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    correction_id uuid NOT NULL UNIQUE,
    account_key text NOT NULL,
    message_id bigint NOT NULL,
    base_evaluation_id bigint NOT NULL,
    schema_version text NOT NULL CHECK (schema_version = '1.0'),
    operation text NOT NULL CHECK (operation IN ('add', 'remove')),
    tag_id text NOT NULL CHECK (tag_id ~ '^[a-z][a-z0-9_]{0,63}$'),
    source text NOT NULL CHECK (source = 'user'),
    correction_hash text NOT NULL CHECK (correction_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (base_evaluation_id, account_key, message_id)
      REFERENCES mailflow.evaluations (id, account_key, message_id)
  );

  CREATE OR REPLACE FUNCTION mailflow.reject_versioned_history_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $function$
  BEGIN
    RAISE EXCEPTION 'Versioned Mailflow history is append-only'
      USING ERRCODE = '42501';
  END
  $function$;

  CREATE TRIGGER account_configuration_revisions_append_only
    BEFORE UPDATE OR DELETE ON mailflow.account_configuration_revisions
    FOR EACH ROW EXECUTE FUNCTION mailflow.reject_versioned_history_mutation();
  CREATE TRIGGER versioned_evaluation_batches_append_only
    BEFORE UPDATE OR DELETE ON mailflow.versioned_evaluation_batches
    FOR EACH ROW EXECUTE FUNCTION mailflow.reject_versioned_history_mutation();
  CREATE TRIGGER evaluations_append_only
    BEFORE UPDATE OR DELETE ON mailflow.evaluations
    FOR EACH ROW EXECUTE FUNCTION mailflow.reject_versioned_history_mutation();
  CREATE TRIGGER evaluation_tag_assignments_append_only
    BEFORE UPDATE OR DELETE ON mailflow.evaluation_tag_assignments
    FOR EACH ROW EXECUTE FUNCTION mailflow.reject_versioned_history_mutation();
  CREATE TRIGGER tag_corrections_append_only
    BEFORE UPDATE OR DELETE ON mailflow.tag_corrections
    FOR EACH ROW EXECUTE FUNCTION mailflow.reject_versioned_history_mutation();

  INSERT INTO mailflow.schema_migrations (version) VALUES (3);
END
$migration$;

COMMIT;

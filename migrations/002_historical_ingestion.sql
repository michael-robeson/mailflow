BEGIN;
SELECT pg_advisory_xact_lock(765274821);

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mailflow.schema_migrations WHERE version = 1) THEN
    RAISE EXCEPTION 'Persistence foundation migration is required';
  END IF;
  IF EXISTS (SELECT 1 FROM mailflow.schema_migrations WHERE version = 2) THEN
    RETURN;
  END IF;

  CREATE TABLE mailflow.historical_ingestions (
    id uuid PRIMARY KEY,
    account_key text NOT NULL CHECK (account_key ~ '^[A-Za-z0-9_-]{1,128}$'),
    config_hash text NOT NULL CHECK (config_hash ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );

  CREATE TABLE mailflow.historical_checkpoints (
    ingestion_id uuid NOT NULL REFERENCES mailflow.historical_ingestions (id),
    page_number integer NOT NULL CHECK (page_number > 0),
    state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (ingestion_id, page_number)
  );

  INSERT INTO mailflow.schema_migrations (version) VALUES (2);
END
$migration$;

COMMIT;

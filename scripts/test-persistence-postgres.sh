#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$root/coverage/postgres"
db_id=
client_id=
cleanup() {
  status=$?
  trap - EXIT
  set +e
  if [ -n "$client_id" ]; then docker rm -f "$client_id" >/dev/null || status=1; fi
  if [ -n "$db_id" ]; then docker rm -f "$db_id" >/dev/null || status=1; fi
  exit "$status"
}
trap cleanup EXIT

# Trust authentication is confined to this synthetic, network-isolated database.
db_id=$(docker run -d --pull=never --network none --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17.11-alpine)
i=0
until docker exec "$db_id" pg_isready -U postgres -d postgres >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then echo "Isolated PostgreSQL did not become ready" >&2; exit 1; fi
  sleep 1
done
docker exec -i "$db_id" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < "$root/migrations/001_persistence_foundation.sql"
docker exec -i "$db_id" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < "$root/migrations/001_persistence_foundation.sql"
docker exec -i "$db_id" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < "$root/migrations/002_historical_ingestion.sql"
docker exec -i "$db_id" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < "$root/migrations/002_historical_ingestion.sql"
docker exec -i "$db_id" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < "$root/migrations/003_versioned_evaluation_persistence.sql"
docker exec -i "$db_id" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < "$root/migrations/003_versioned_evaluation_persistence.sql"
docker exec -i "$db_id" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
CREATE ROLE mailflow_test_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE postgres TO mailflow_test_app;
GRANT USAGE ON SCHEMA mailflow TO mailflow_test_app;
GRANT SELECT ON mailflow.schema_migrations TO mailflow_test_app;
GRANT SELECT, INSERT ON mailflow.messages, mailflow.classifications, mailflow.policy_decisions,
  mailflow.workflow_runs, mailflow.action_log, mailflow.historical_ingestions,
  mailflow.historical_checkpoints TO mailflow_test_app;
GRANT SELECT, INSERT ON mailflow.account_configuration_revisions,
  mailflow.versioned_evaluation_batches, mailflow.evaluations,
  mailflow.evaluation_tag_assignments, mailflow.tag_corrections TO mailflow_test_app;
GRANT SELECT, INSERT, UPDATE ON mailflow.current_effective_evaluations TO mailflow_test_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mailflow TO mailflow_test_app;
SQL

client_id=$(docker run -d --pull=never --network "container:$db_id" --entrypoint node \
  docker.n8n.io/n8nio/n8n:2.47.4 -e 'setInterval(() => {}, 1000)')
docker exec "$client_id" mkdir -p /tmp/mailflow-test/lib /tmp/mailflow-test/tests/integration
for file in "$root"/lib/*.cjs; do
  docker cp "$file" "$client_id:/tmp/mailflow-test/lib/"
done
docker cp "$root/tests/integration/persistence-postgres.cjs" "$client_id:/tmp/mailflow-test/tests/integration/persistence-postgres.cjs"
docker cp "$root/tests/integration/live-persistence-postgres.cjs" "$client_id:/tmp/mailflow-test/tests/integration/live-persistence-postgres.cjs"
docker cp "$root/tests/integration/historical-ingestion-postgres.cjs" "$client_id:/tmp/mailflow-test/tests/integration/historical-ingestion-postgres.cjs"
docker cp "$root/tests/integration/versioned-persistence-postgres.cjs" "$client_id:/tmp/mailflow-test/tests/integration/versioned-persistence-postgres.cjs"

test_failures=0
run_integration() {
  suite=$1
  file=$2
  if docker exec -e NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules "$client_id" \
    node --test --test-reporter=tap "/tmp/mailflow-test/tests/integration/$file" \
    > "$root/coverage/postgres/$suite.tap" 2>&1; then
    cat "$root/coverage/postgres/$suite.tap"
  else
    result=$?
    cat "$root/coverage/postgres/$suite.tap"
    test_failures=1
    return "$result"
  fi
}

run_integration persistence-postgres persistence-postgres.cjs || true
run_integration live-persistence-postgres live-persistence-postgres.cjs || true
run_integration historical-ingestion-postgres historical-ingestion-postgres.cjs || true
run_integration versioned-persistence-postgres versioned-persistence-postgres.cjs || true
if [ "$test_failures" -ne 0 ]; then exit 1; fi

docker exec -i "$db_id" psql -X -v ON_ERROR_STOP=1 -U mailflow_test_app -d postgres < "$root/sql/persistence-reports.sql"

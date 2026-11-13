#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
db_id=
client_id=
cleanup() {
  status=$?
  trap - EXIT
  set +e
  if [ -n "$client_id" ]; then docker rm -fv "$client_id" >/dev/null || status=1; fi
  if [ -n "$db_id" ]; then docker rm -fv "$db_id" >/dev/null || status=1; fi
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
docker exec -i "$db_id" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
CREATE ROLE mailflow_test_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE postgres TO mailflow_test_app;
GRANT USAGE ON SCHEMA mailflow TO mailflow_test_app;
GRANT SELECT ON mailflow.schema_migrations TO mailflow_test_app;
GRANT SELECT, INSERT ON mailflow.messages, mailflow.classifications, mailflow.policy_decisions,
  mailflow.workflow_runs, mailflow.action_log TO mailflow_test_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mailflow TO mailflow_test_app;
SQL

client_id=$(docker run -d --pull=never --network "container:$db_id" --entrypoint node \
  docker.n8n.io/n8nio/n8n:2.47.4 -e 'setInterval(() => {}, 1000)')
docker exec "$client_id" mkdir -p /tmp/mailflow-test/lib /tmp/mailflow-test/tests/integration
docker cp "$root/lib/persistence.cjs" "$client_id:/tmp/mailflow-test/lib/persistence.cjs"
docker cp "$root/tests/integration/persistence-postgres.cjs" "$client_id:/tmp/mailflow-test/tests/integration/persistence-postgres.cjs"
docker exec -e NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules "$client_id" \
  node --test /tmp/mailflow-test/tests/integration/persistence-postgres.cjs

# Workflow 09 synthetic runtime verification

This harness prepares a disposable local runtime for the successful three-page
workflow 09 scenario. It does not start containers, create a database, or
execute workflows by itself. The test run requires separate explicit approval
for those runtime operations.

The temporary parent is derived from the checked-in
[multi-page export](../workflows/09-mailflow-historical-multi-page.json); its
embedded one-page child is derived from the checked-in
[child export](../workflows/09-mailflow-historical-one-page.json). Only
temporary copies are configured. The original exports remain inactive,
unbound, and unchanged.

## What is exercised

The runtime uses n8n `2.47.4`, PostgreSQL `17.11-alpine`, the existing
`mailflow-pipeline` modules, and migrations 001, 002, and 003. Its temporary
parent explicitly enables M1 with built-in configuration defaults
(`configurationRevisionId: null`), an ingestion UUID, an opaque account key,
page size 2, and maximum 10.
The child uses GET-only HTTP Request nodes against a local fixture service
instead of Gmail; no OAuth credential is configured.

The fixture returns:

1. `w09_msg_001` and `w09_msg_002`, with `w09_page_2`.
2. `w09_msg_003` and `w09_msg_004`, with `w09_page_3`.
3. `w09_msg_005`, with no continuation token.

Each message uses the synthetic “Job alert” fixture already used by the
historical persistence tests. The harness verifies five versioned historical
evaluations and tag assignments, no current-effective selections, and the
category-based `job_alert`/weekly policy default, alongside the unchanged v1
historical results. In the temporary child copy only, a test-only
HTTP marker runs after the awaited page-persistence call and then returns the
original page result. The fixture requires a marker for page N before serving
page N+1, and records the ordered list, message, and checkpoint events. This
causal gate avoids comparing timestamps from different containers. The SQL
query separately verifies the final checkpoints and aggregate counts. The
parent and child remain inactive; import the generated parent into the
isolated instance and run its draft manually. Its child definition is embedded
using **Define Below**, preserving the checked-in parent-child structure.

The n8n operational database and Mailflow application database are separate
PostgreSQL services. Both databases and n8n’s local data directory use tmpfs;
there are no named data volumes. The two networks are internal-only. The
fixture is reachable from n8n but not from the application-database network.
Only the n8n editor port is published, bound to loopback on a dynamically
assigned host port. The internal Task Runner is enabled explicitly in the n8n
service and shares that container's network. Images use `pull_policy: never`;
acquire the pinned images separately, with approval, if they are not already
local.

The fixture and n8n run as the invoking POSIX user/group. Their staged package
and fixture files are owned by that user and owner-readable; the runtime
directory and package directories are mode 0700. Credentials and bootstrap
SQL remain mode 0600. The disposable application PostgreSQL entrypoint runs as
its normal image user. Bootstrap SQL is not bind-mounted; it is sent over
stdin to `psql` after the disposable database is healthy, so the file remains
private on the host. Every bind mount from the generated staging directory
uses read-only shared SELinux relabeling (`:ro,z`) where supported. This
labels only disposable staging assets, not the repository or existing
volumes. The n8n data tmpfs is owned by the configured runtime UID/GID with
mode 0700, allowing n8n to initialize without making its state world-writable.

## Prerequisites and preparation

Use Bash from the repository root. Required local tools are Node.js 22,
Docker Engine, and Docker Compose. The runtime depends on the staged
`mailflow-pipeline` package and the `pg` module already included in the pinned
n8n image. The Task Runner must load the staged package; start a fresh test
instance after staging rather than relying on a previously cached package.

Run the following only after reviewing the generated harness code. This first
command prepares files under a new private directory in the OS temporary
directory; it does not call Docker or PostgreSQL:

```bash
node scripts/prepare-workflow-09-runtime.cjs
```

The script prints the directory and Compose project name, plus a non-secret
command to source `runtime-paths.sh`. Use the exact source command it prints.
The generated directory is mode 0700; generated password files and SQL
bootstrap material are mode 0600. The runtime directory contains the
temporary package, migration copies, workflow copies, mock fixture,
credentials, scenario metadata, and a sanitized evidence query. Do not copy
it into the repository or share its generated files.

## Provisioning commands — require explicit runtime approval

The following commands are the planned setup, not commands run as part of
this implementation task. After separately approving container and database
operations, source the generated paths, then provision the uniquely named
project:

```bash
. /tmp/mailflow-w09-runtime-<generated-suffix>/runtime-paths.sh
: "${W09_RUNTIME_DIR:?source runtime-paths.sh first}"
: "${W09_PROJECT:?source runtime-paths.sh first}"
node scripts/verify-workflow-09-compose-project.cjs \
  "$W09_RUNTIME_DIR" "$W09_PROJECT" assert-new
docker compose -p "$W09_PROJECT" \
  --env-file "$W09_RUNTIME_DIR/compose.env" \
  -f tests/runtime/workflow-09/compose.yaml \
  up -d --wait
```

The `assert-new` check uses Docker's read-only container and network listings;
it fails closed if the project label is already occupied. After provisioning,
run `assert-owned` immediately before every later `docker compose` operation
(`exec`, `logs`, `port`, or `down`); it validates that any matching resources
belong to this harness, the exact Compose and generated environment files, and
the Compose file's directory (the `working_dir` label emitted by Compose).

`mailflow-postgres` initializes only the disposable `mailflow` database. Feed
the role bootstrap SQL to that database over stdin; this keeps the generated
mode-0600 SQL off container bind mounts:

```bash
node scripts/verify-workflow-09-compose-project.cjs \
  "$W09_RUNTIME_DIR" "$W09_PROJECT" assert-owned
docker compose -p "$W09_PROJECT" \
  --env-file "$W09_RUNTIME_DIR/compose.env" \
  -f tests/runtime/workflow-09/compose.yaml \
  exec -T mailflow-postgres \
  psql -X -U mailflow_admin -d mailflow -v ON_ERROR_STOP=1 \
  < "$W09_RUNTIME_DIR/app-bootstrap.sql"
```

The bootstrap creates separate `mailflow_owner` and restricted `mailflow_app`
roles. Apply all three migrations as `mailflow_owner`; the connection uses the
disposable local PostgreSQL administrator only to assume the migration-owner
role:

```bash
node scripts/verify-workflow-09-compose-project.cjs \
  "$W09_RUNTIME_DIR" "$W09_PROJECT" assert-owned
set -o pipefail
for migration in \
  001_persistence_foundation.sql \
  002_historical_ingestion.sql \
  003_versioned_evaluation_persistence.sql; do
  {
    printf 'SET ROLE mailflow_owner;\n'
    cat "$W09_RUNTIME_DIR/migrations/$migration"
  } | docker compose -p "$W09_PROJECT" \
    --env-file "$W09_RUNTIME_DIR/compose.env" \
    -f tests/runtime/workflow-09/compose.yaml \
    exec -T mailflow-postgres \
    psql -X -U mailflow_admin -d mailflow -v ON_ERROR_STOP=1
done
```

Grant the runtime role only the application-table access required by the
v1, historical, and versioned persistence adapters:

```bash
node scripts/verify-workflow-09-compose-project.cjs \
  "$W09_RUNTIME_DIR" "$W09_PROJECT" assert-owned
docker compose -p "$W09_PROJECT" \
  --env-file "$W09_RUNTIME_DIR/compose.env" \
  -f tests/runtime/workflow-09/compose.yaml \
  exec -T mailflow-postgres \
  psql -X -U mailflow_admin -d mailflow -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE mailflow_owner;
REVOKE ALL ON SCHEMA mailflow FROM PUBLIC;
GRANT USAGE ON SCHEMA mailflow TO mailflow_app;
GRANT SELECT ON mailflow.schema_migrations TO mailflow_app;
GRANT SELECT, INSERT ON mailflow.messages, mailflow.classifications,
  mailflow.policy_decisions, mailflow.workflow_runs, mailflow.action_log,
  mailflow.historical_ingestions, mailflow.historical_checkpoints TO mailflow_app;
GRANT SELECT, INSERT ON mailflow.account_configuration_revisions,
  mailflow.versioned_evaluation_batches, mailflow.evaluations,
  mailflow.evaluation_tag_assignments, mailflow.tag_corrections TO mailflow_app;
GRANT SELECT, INSERT, UPDATE ON mailflow.current_effective_evaluations TO mailflow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mailflow TO mailflow_app;
SQL
```

## Execute the first scenario — require explicit workflow approval

Get the loopback editor URL from this command and complete the disposable
n8n owner setup locally; do not create or bind a Gmail credential:

```bash
node scripts/verify-workflow-09-compose-project.cjs \
  "$W09_RUNTIME_DIR" "$W09_PROJECT" assert-owned
docker compose -p "$W09_PROJECT" \
  --env-file "$W09_RUNTIME_DIR/compose.env" \
  -f tests/runtime/workflow-09/compose.yaml \
  port n8n 5678
```

Import only `$W09_RUNTIME_DIR/workflows/parent.json` into this isolated n8n
instance. Confirm it is inactive, unbound, and contains the complete embedded
child definition with the local mock URLs. Manually execute the parent’s
editor draft; do not publish or activate either workflow. Each runtime run
requires separate task-specific approval; the recorded result below is
evidence for one authorized execution, not authorization to rerun it.

## Evidence and acceptance

Inspect the fixture’s structured request log:

```bash
node scripts/verify-workflow-09-compose-project.cjs \
  "$W09_RUNTIME_DIR" "$W09_PROJECT" assert-owned
docker compose -p "$W09_PROJECT" \
  --env-file "$W09_RUNTIME_DIR/compose.env" \
  -f tests/runtime/workflow-09/compose.yaml \
  logs --no-color --no-log-prefix w09-gmail-mock
```

The expected log has exactly three list events in order: no token,
`w09_page_2`, and `w09_page_3`, each with `maxResults=2`; five detail events,
one for each synthetic ID; and checkpoint markers 1, 2, and 3. The event
sequence must show each page's checkpoint marker before the following list
event, with no rejected requests. The fixture refuses to serve the following
page before it receives the marker. Because the marker node is downstream of
the awaited database persistence call, this establishes causal ordering
without comparing container clocks.

Inspect only counts and checkpoint metadata; the query deliberately excludes
message IDs, page tokens, message bodies, and credentials:

```bash
node scripts/verify-workflow-09-compose-project.cjs \
  "$W09_RUNTIME_DIR" "$W09_PROJECT" assert-owned
docker compose -p "$W09_PROJECT" \
  --env-file "$W09_RUNTIME_DIR/compose.env" \
  -f tests/runtime/workflow-09/compose.yaml \
  exec -T mailflow-postgres \
  psql -X -U mailflow_admin -d mailflow -v ON_ERROR_STOP=1 \
  < "$W09_RUNTIME_DIR/verify-success.sql"
```

The SQL exits with an error unless there are sequential checkpoints 1–3,
the final checkpoint reports 5 discovered and persisted messages with no
continuation token, and the database has exactly five v1 runs, message
identities, classifications, and policy decisions plus five versioned
historical evaluations and category-matching built-in tag assignments. It
also rejects any current-effective selection. It prints each checkpoint’s
page number, timestamp, cumulative discovered and persisted counts, failure
count, and `has_more` flag. The final sanitized report must show
`pages=3`, `discovered=5`,
`processed=5`, `persisted=5`, `previouslyProcessed=0`, `failed=0`,
`stopReason=exhausted`, and `hasMore=false`. Record only that report and the
fixture/SQL evidence; do not save or share raw node execution output.

## Recorded runtime result (2026-11-16)

One authorized run executed the staged parent draft manually in n8n `2.47.4`.
The parent and its embedded child remained inactive and unbound. The child
used only the synthetic fixture; no Gmail OAuth or live Gmail access was
used. A separate inactive diagnostic workflow confirmed that the internal
JavaScript Task Runner loaded `mailflow-pipeline` and resolved all eight
expected exports.

The fixture served three pages of 2, 2, and 1 synthetic messages, with a
maximum configured above the fixture total. Runtime evidence showed three
ordered list requests (initial, `w09_page_2`, `w09_page_3`), five detail
requests, and three successful checkpoints. Each checkpoint completed before
the following page request. The read-only database check found three
checkpoints and five each of workflow runs, messages, classifications, and
policy decisions; the five decisions were associated with five distinct
classifications. Checkpoint cumulative discovered/persisted counts were 2, 4,
and 5.

The sanitized final report was `pages=3`, `discovered=5`, `processed=5`,
`persisted=5`, `previouslyProcessed=0`, `failed=0`,
`stoppedAtLimit=false`, `hasMore=false`, `stopReason=exhausted`. The editor's
Executions view showed no retained execution, and the workflows remained
inactive.

The editor displayed **“Workflow: undefined”** and **“out of date”** for the
inline Execute Workflow node. This was nonblocking for the successful run,
but remains pending investigation; it is not considered resolved by the
runtime result.

## Recorded M1 runtime result (2026-11-17)

The updated parent and embedded child were imported inactive into a fresh
project using this harness. The actual n8n engine was exercised with one-shot
`n8n execute` containers because this Docker Compose engine did not assign a
host port for the editor binding. No workflow was activated, no Gmail
credential was configured, and every HTTP request went to the synthetic
fixture. A direct `n8n execute` inside the long-running n8n container could
not start a second task broker on its occupied port; the one-shot Compose
execution succeeded. The container logged that its optional Python runner
was unavailable, but the Node Code nodes and child workflow executed.

The M1-enabled built-in-default run and the M1-disabled compatibility run each
processed three pages and five messages, with checkpoints 1–3. The enabled
run stored five historical evaluations and five built-in assignments whose
tag IDs matched their classification categories; its v1 records were also
present. The disabled run stored no versioned evaluations and retained five
v1 runs, classifications, policy decisions, and three checkpoints.

A separate account-scoped configuration revision was pinned through the
parent. All five historical evaluations recorded that revision and version.
Its `job_alert` override changed priority to `high` and recommended action to
`review`, while notification eligibility and cadence remained `true` and
`weekly`, respectively; the legacy action remained `weekly`.

Two retry scenarios injected permission failures in the disposable database.
When v1 `workflow_runs` insertion failed after the first page’s M1 writes,
the first attempt left two M1 evaluations/tags, no v1 records, and no
checkpoint. Retrying with the same ingestion configuration completed with
five unique M1 evaluations/tags, five v1 runs, and three checkpoints. When
checkpoint insertion failed after both M1 and v1 message persistence, the
first attempt left two records in each history and no checkpoint. The same
configuration then retried with two previously processed messages and
completed with five unique M1 evaluations/tags, five v1 runs, and three
checkpoints. All scenarios ended with zero current-effective rows. Temporary
database grants used to inject the failures were restored.

Fixture logs showed no rejected requests. Each successful run had three
ordered list events, five detail events, and checkpoints 1–3 before any next
page; each failed run stopped on page one without a checkpoint marker. The
web editor itself was not exercised because no host port was allocated. The
isolated project and temporary staging files are being retained for review;
cleanup requires separate approval.

## Cleanup — require separate explicit approval

After evidence has been reviewed and cleanup is authorized, verify that the
named project still belongs to this harness, stop only that project, and
remove its temporary preparation files:

```bash
node scripts/verify-workflow-09-compose-project.cjs \
  "$W09_RUNTIME_DIR" "$W09_PROJECT" assert-owned
docker compose -p "$W09_PROJECT" \
  --env-file "$W09_RUNTIME_DIR/compose.env" \
  -f tests/runtime/workflow-09/compose.yaml \
  down --remove-orphans
node scripts/cleanup-workflow-09-runtime.cjs "$W09_RUNTIME_DIR" --confirm
```

The preflight rejects a missing, malformed, or mismatched project identifier.
Before provisioning it refuses any existing container or network using the
generated project label, so Compose cannot reuse those resources. Before
teardown it checks container labels against this repository's exact Compose
file and working directory and checks network labels/names; a project
containing non-harness resources is refused. The Compose file defines no
named data volumes, so cleanup does not remove or alter existing
development/production volumes. The file cleanup helper independently
refuses paths outside the generated workflow 09 temporary directory and
requires the explicit `--confirm` option. If execution fails, preserve the
isolated environment until sanitized evidence is collected and recovery is
reviewed; do not rerun with a changed ingestion UUID/configuration or run the
same ingestion concurrently.

## Scope and gaps

The increment modifies the 09 workflow exports, pipeline persistence
integration, runtime preparation/verification tooling, and related docs/tests.
The recorded runtime evidence verifies the requested M1 and retry scenarios.
It does not verify:

- Stopping at the configured message limit.
- Resuming from a checkpoint committed on an earlier page.
- Retrieval failure.
- M1 persistence failure before v1 persistence.
- Execution through the web editor; the local host port was not published.

Offline synthetic/unit tests cover related logic for those remaining gaps.
`tests/workflow-09-runtime.test.cjs` tests fixture ordering
and its checkpoint gate, temporary workflow configuration, isolation
configuration, and evidence-query construction.
`tests/historical-ingestion.test.cjs` tests modeled pagination,
checkpoint/resume, limit, and retrieval/persistence failure behavior;
`tests/persistence.test.cjs` tests idempotency and write failures with a fake
database client. These tests are not substitutes for runtime evidence.

Both workflow copies retain `saveDataErrorExecution=none`,
`saveDataSuccessExecution=none`, `saveManualExecutions=false`, and
`saveExecutionProgress=false`. Transient node data, editor state, process
memory, and container logs can still retain synthetic data. The runtime
contains no Gmail OAuth credentials and has no external container network. Do
not reuse its temporary passwords, account key, or database for any other
environment.

The actual engine runs confirmed execution of the embedded child with the
pinned n8n `2.47.4` image. They do not validate other n8n versions or
live-provider behavior. An optional n8n MCP-registry lookup failure recorded
for the earlier editor run is unrelated to these scenarios; no external
connectivity was enabled or required.
Continue to treat execution data, logs, database contents, and temporary
credentials as sensitive, even in this synthetic environment.

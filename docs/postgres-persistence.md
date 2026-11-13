# PostgreSQL persistence foundation

Phase 1F-C supplies a migration and a standalone persistence adapter. On
November 13, 2026, migration 1 was applied as the dedicated owner to a new
local application database, and synthetic persistence was verified. The
existing n8n PostgreSQL server was not migrated. No n8n workflow is connected
to the new database; any live integration requires separate approval.

## Isolation and data model

The existing Compose PostgreSQL service stores n8n's internal data, and its
`n8n` bootstrap role has PostgreSQL superuser privileges. Do not reuse that
database, role, volume, or credentials for Mailflow application data. The
chosen design is a **separate PostgreSQL service and volume**, with a
dedicated `mailflow` database, migration owner, and restricted runtime role.
This avoids sharing n8n's database cluster and its backup/restore lifecycle.
The opt-in [Compose override](../compose.mailflow-db.yaml) defines that
service with no published ports, its own named volume, and an internal network
not shared with n8n. It is not started by the default Compose configuration.
Network access, resource limits, secret management, retention and any future
integration still require review. Do not expose PostgreSQL publicly.

## Local deployment and verification

The local service uses PostgreSQL 17.11, `mailflow_application_data`, and
`mailflow_persistence`. It is independent of the existing n8n PostgreSQL
container and volume. The authorized deployment created a private
`~/.config/mailflow/phase-1fc` directory (mode 700) containing a Compose
environment file and a credentials JSON file (mode 600). The latter holds
distinct generated admin, owner, and app credentials. Protect and back up
these files separately; do not commit, print, or copy them into logs.

The bootstrap administrator password is passed to the container as an
environment variable: local users with Docker daemon access can inspect it.
This is a local-development setup, not a production secrets mechanism.
Changing the environment file later does **not** rotate passwords already
stored in the PostgreSQL volume. Do not delete the volume to rotate secrets.
Database connections inside the isolated network are not TLS-encrypted;
future integrations must review transport and network access.

To operate the existing application service without recreating n8n, use the
two Compose files and both private environment files:

```sh
docker compose --env-file .env --env-file "$HOME/.config/mailflow/phase-1fc/compose.env" \
  -f compose.yaml -f compose.mailflow-db.yaml up -d --no-deps mailflow-postgres
```

Do not run `docker compose config` without `--quiet`: it can print secrets.
Do not use `down --volumes` or delete either database volume. Initial role
creation and migration were performed by
[provision-persistence.cjs](../scripts/provision-persistence.cjs) in a
temporary client on the new service's network namespace. The script accepts
the private credentials JSON on standard input, checks for a fresh database,
creates the two roles, and runs migration 1 as `mailflow_owner`. It refuses to
reprovision an existing schema or role; if provisioning fails after role
creation, inspect and recover the new cluster explicitly rather than rerunning
blindly. The migration and grants are separate steps, so check both before
using an interrupted deployment. The script uses an existing n8n image only
as a disposable PostgreSQL client; it does not touch the running n8n container.

The restricted application role performed synthetic inserts and queries,
identical and conflicting retries, historical decisions, injected rollback,
and concurrent retries. Its attempts to alter, update, and delete were
denied. The n8n cluster has no `mailflow_app` role and is on a different
network; an authentication attempt using the application role against n8n's
database was also denied. This does not establish safety if networks or
credentials are later changed. Synthetic records remain in the application
database; no live mail was stored. The schema contains no body, subject, or
sender columns.

The deployed synthetic test at
[deployed-persistence.cjs](../tests/integration/deployed-persistence.cjs)
uses fresh synthetic account keys and run IDs on each invocation, and leaves
its test records in the application database. It expects a `pg` driver, the
adapter at `../../lib/persistence.cjs`, and the application password on
standard input. It must only be run with approval on an explicitly selected
test database; it must not be pointed at n8n's database or used to test real
mail. The existing isolated regression test below uses a disposable database
and does not retain its synthetic records.

Migration 1 creates the `mailflow` schema:

| Table | Purpose and constraints |
| --- | --- |
| `messages` | Opaque account key, Gmail message ID, optional received timestamp and first-processing time. `(account_key, gmail_message_id)` is unique. |
| `workflow_runs` | Caller-supplied UUID, account key, batch hash and successful processing timestamp. |
| `classifications` | Append-only category, status, rule and explanation codes, timestamp, message and run. One classification per message per run; composite foreign keys enforce account consistency. |
| `policy_decisions` | Append-only action, status, explanation codes and timestamp; exactly one may be stored per classification. |
| `action_log` | Future audit events with caller-supplied UUID, account-scoped message reference, action and outcome codes, and event/recording timestamps. It performs no Gmail action. |
| `schema_migrations` | Applied migration versions and timestamps. |

No sender, subject, body, raw headers, Gmail thread, credential, or raw error
is stored. IDs, account keys, dates, decision codes and hashes are still
sensitive metadata. Use an opaque, stable account key, not an email address.
Account keys provide identity separation, **not** per-account access control;
the application role can read all accounts. The schema and runtime role
prohibit updates/deletes by the application role, but the owner or an
administrator can change records; this is not tamper-proof auditing.

## Adapter

`lib/persistence.cjs` exports `createPersistenceAdapter(pool)`. The caller
supplies a PostgreSQL pool compatible with `pg`'s `connect()`, `query(text,
values)`, and `release(error)` API; the adapter does not install a driver or
read credentials. It has not been integrated into the n8n Task Runner.
Provision the driver and connection through an approved future integration;
never put a connection string or credential in workflow code, Git or logs.

Call `adapter.persistBatch({ runId, accountKey, items })`. Each item contains
only `gmailMessageId`, optional UTC `receivedAt`, `classification` with
`category`, `status`, `matchedRuleIds`, `explanationCodes`, and `policy` with
`action`, `status`, `explanationCodes`. Codes use lowercase letters, digits
and underscores; unexpected fields, invalid IDs, invalid timestamps, duplicate
IDs and more than 25 items are rejected before connecting. This API accepts
classification and policy components separately, not the combined sanitized
Phase 1F-B report, which intentionally omits Gmail IDs. An integration must
explicitly construct these fields before sanitization without logging content.

Each call uses parameterized SQL in one transaction. Reusing the same UUID
and identical normalized input returns `{ runId, alreadyProcessed: true,
count }` without adding rows; different input for that UUID fails. A new UUID
records new classification and policy history for the same message. Item and
code array order is significant for retries. Concurrent identical retries are
serialized by the unique run ID. `received_at` is set on first insertion and
is not overwritten on later runs. A run and all its decisions commit together;
failed transactions leave no run record, so this is not yet a failed-run
monitoring system. Commit or connection errors can leave the outcome unknown;
retry the identical batch with the same UUID. The batch hash is unkeyed and
must be treated as sensitive, not as anonymization.

The adapter exposes no action execution or action-log writer. Future approved
integrations must design and test audit event writing, authorization, retries,
retention, and access controls before using that table. Database/driver errors
may include SQL details or values: callers must handle failures explicitly but
must not log raw exceptions or sensitive inputs.

## Provisioning and migration after approval

1. Back up the existing n8n installation independently. Provision a separate
   PostgreSQL 17 service and private volume, not the existing Compose service.
   Use TLS or an equivalently protected private transport appropriate to the
   deployment. Restrict host and network access.
2. With the new cluster's administrator, create a dedicated login role
   `mailflow_owner` (no superuser, createdb, createrole, or replication
   privileges), a separate login role `mailflow_app` with the same
   restrictions, and a database `mailflow` owned by `mailflow_owner`. Set
   distinct credentials through a secure interactive or secret-management
   mechanism, not SQL history, source files, command arguments, or logs.
   Revoke public database access and grant `CONNECT` only to required roles.
   Keep administrator and owner credentials out of the application.
3. Connect to the new `mailflow` database as `mailflow_owner`, then apply
   `migrations/001_persistence_foundation.sql` with `psql -X -v
   ON_ERROR_STOP=1` and the migration file as input. Use a protected
   `PGSERVICE`/`PGPASSFILE` or interactive authentication. Never point this
   command at the n8n database. The migration runs in a transaction, takes a
   transaction-scoped advisory lock, records version 1 and can be rerun.
   Apply subsequent numbered migrations in order; never edit an already
   applied migration. The ledger records versions, not checksums: verify
   migration provenance and version before deployment.
4. As owner, revoke public access to the `mailflow` schema and grant the
   runtime role only:

   ```sql
   GRANT USAGE ON SCHEMA mailflow TO mailflow_app;
   GRANT SELECT ON mailflow.schema_migrations TO mailflow_app;
   GRANT SELECT, INSERT ON mailflow.messages, mailflow.classifications,
     mailflow.policy_decisions, mailflow.workflow_runs, mailflow.action_log TO mailflow_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mailflow TO mailflow_app;
   ```

   Revisit grants for each future migration. Verify the app role cannot
   create, alter, update, delete, or access n8n data, and that no public or
   inherited grants defeat those restrictions. The connection pool should use
   the runtime role, not the owner or administrator.

The isolated regression test applies migration 1 twice and tests the adapter
using a non-superuser insert/select role. Run `sh scripts/test-persistence-postgres.sh`
only with approval to create and remove disposable containers. It requires
the locally cached PostgreSQL 17.11 and n8n 2.47.4 images, uses a networkless
temporary database with synthetic data, and does not contact the existing
database or Gmail. Its trust authentication is strictly for that isolated
test and must never be copied into a deployment.

## Backup and recovery

Before any migration and on a reviewed schedule, use a PostgreSQL-consistent
custom-format `pg_dump` of the dedicated application database, using an
appropriately authorized backup role and secure authentication. Store backups
outside the repository in access-controlled, encrypted storage; define and
test retention and deletion policies. Database dumps do not include cluster
roles or their credentials; separately document and protect role provisioning
and secret recovery. Never print dumps or credentials in logs.

Regularly restore a backup into a **new isolated** test database or cluster
using `pg_restore --exit-on-error --no-owner --no-acl`, with the intended
owner, then reapply reviewed grants. Verify migration versions, constraints,
row counts and sample synthetic operations without exposing real metadata.
For recovery, stop application writes, take a fresh backup if possible, and
obtain approval before restoring to any replacement environment. Never restore
over n8n's database or volume. Restore testing and production backup
automation are not implemented by this foundation.

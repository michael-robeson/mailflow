# Live Gmail to PostgreSQL integration

Phase 1F-D provides a separate inactive, unbound, manual-only
[workflow](../workflows/06-mailflow-gmail-persistence.json); the existing
Phase 1F-B workflow and imported instance are unchanged. **Do not run it
against Gmail without separate approval.** The default run UUID and account
key are empty and the workflow fails before any Gmail request until both are
configured. The export's generic query is not approval for a live run. It uses
the same 1–25 bound, single-page GET requests, shared normalization,
classification and policy modules, and no-save settings as Phase 1F-B.
There are no Gmail writes, delivery nodes or automatic triggers.

The processed items retain Gmail message and thread IDs internally; thread IDs
are not stored. The persistence mapping writes message ID, optional received
timestamp, separate classification and policy statuses, rule and explanation
codes, and run metadata. Retrieval and processing failures produce safe
`other` / `none` records with their failure status, while other items
continue. The final report has ordinal decisions, aggregate errors, and a
persistence count, not IDs, email content or raw errors. An empty result
persists an empty run. Database failure stops the workflow instead of
returning a success-shaped report.

`mailflow.messages` deduplicates identity per opaque account key. Each new run
UUID records new classification/policy history. Reusing the same UUID with
identical input is idempotent; different input is rejected. Use a fresh UUID
for every new logical run. A failed connection or commit may leave the
outcome unknown: reuse the same UUID **only with the identical processed
batch**. Rerunning Gmail retrieval can select different messages or results,
so is not necessarily an identical retry. With no-save execution settings,
reconstructing that exact batch may not be possible; do not assume retries
are automatically safe. The UUID and account key must be configured manually
in the workflow; an opaque account key does not verify Gmail identity. Verify
it refers to the intended authorized account before execution.

## Local runtime

The opt-in [integration override](../compose.mailflow-integration.yaml) adds
n8n to the internal `mailflow_persistence` network, keeps the database without
a host port, and mounts only the named `mailflow-pipeline` package and an
app-role-only credential directory read-only. The runner reads
`/run/mailflow/app-password` and connects as `mailflow_app`; it never reads
the owner credential. The package uses the n8n image's installed `pg` driver.
The host staging directories must be readable by the n8n container UID; on
SELinux hosts the override labels **only disposable staging directories** with
`:z`. Never relabel the repository, home, or persistent volumes. The
application credential is accessible to n8n container processes and trusted
allowlisted package code; the application role can read and insert data for
all accounts. Anyone able to run arbitrary trusted code in n8n may therefore
use that privilege. The existing network continues to permit Gmail access;
the database connection has no TLS. Internal Docker networking is not a
boundary against host or Docker administrators.

The local synthetic verification used fresh staging under `/tmp`, which is not
durable. The package and secret
must be recreated after cleanup or reboot, and updated package code is not
automatically reflected in the staged copy. The staged secret is a separate
copy and must be rotated or removed in coordination with the local database
credential. Keep directories owner-only and the secret mode 0600; never print
the credential or stage the owner/admin credentials. The package staging
directory and secret staging directory must be distinct and contain only
intended files. Container labels are applied only to these disposable paths.

To reapply the configuration after reviewing paths and obtaining approval,
set `MAILFLOW_PIPELINE_DIR` and `MAILFLOW_APP_SECRET_DIR` to the freshly
prepared absolute directory paths, then run:

```sh
docker compose --env-file .env --env-file "$HOME/.config/mailflow/phase-1fc/compose.env" \
  -f compose.yaml -f compose.mailflow-db.yaml -f compose.mailflow-integration.yaml \
  up -d --no-deps --wait n8n
```

This recreates n8n and temporarily interrupts it. Preserve its existing
volumes, encryption key, and any other required local overrides; review the
merged configuration with `config --quiet` first, never print the resolved
configuration. External Task Runners need equivalent package, credential and
network access independently. Do not mount the credential into a runner that
is not trusted to use the application role.

The separately imported [synthetic workflow](../workflows/07-mailflow-persistence-synthetic.json)
was run twice, with separate approval for the second run, in the actual n8n
2.47.4 JavaScript Task Runner. It wrote one run,
two synthetic message identities, two classifications and two policy
decisions: `job_alert` / `weekly` and an isolated `retrieval_error` / `none`.
The second execution used the same synthetic UUID and returned
`alreadyProcessed: true`. Its local import remains inactive. A separately
approved live run subsequently exercised Gmail processing and persistence;
classification accuracy has not been independently verified.

## Approval checklist for a future live run

1. Review the intended account, exact `gmail.readonly` OAuth scope and GET-only
   nodes; bind the existing Gmail credential locally to both nodes. Keep the
   workflow inactive and manual.
2. Verify app-role-only access, network isolation, staging freshness, no-save
   settings, and the intended bounded query. Set a new explicit UUID and the
   correct opaque account key before execution.
3. Obtain separate approval for a specified query and maximum message count.
   Never display or log message IDs, subjects, senders, bodies, credentials,
   intermediate node output, or raw database errors. The CLI's raw output can
   include sensitive intermediate data even when the final report is sanitized.
4. Review aggregate counts only, and remember n8n editor state, transient
   memory, logs and backups may retain message contents despite no-save
   settings. Never pin live data.

Read-only aggregate queries are in [persistence-reports.sql](../sql/persistence-reports.sql).
They aggregate all accounts and all historical decisions, not only the latest
classification. Aggregate results can be sensitive; access and store them
accordingly. Backups and restore testing remain deferred as described in the
[persistence foundation](postgres-persistence.md#backup-and-recovery).

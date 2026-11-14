# Bounded historical Gmail ingestion

The [historical workflow](../workflows/08-mailflow-historical-ingestion.json)
is an inactive, unbound, manual-only candidate. Synthetic runtime tests and
a separately approved bounded live run have been verified. The export has empty ingestion UUID and account key
and refuses to start until both are configured. Its empty query applies no
search filter; it is not authorization for a live run. Both Gmail requests are GET
only. There are no Gmail modifications, delivery nodes or automatic triggers.

Configure an opaque account key, an explicit ingestion UUID, Gmail query,
page size and maximum number of discovered messages. Each manual execution
processes at most one page. Repeat the manual execution with the same
configuration to continue from its database checkpoint. The defaults are page
size 25 and maximum 100; the respective hard limits are 25 and 1,000. The
final list request is reduced to the remaining allowance. Repeated page
tokens, invalid responses and empty pages with continuation tokens stop the
workflow. The cap counts listed messages, including any repeated identities.
Each execution retains only one page of message data, bounded pagination
tokens and aggregate counters. n8n may retain node outputs and message bodies
in execution memory until that execution ends, even with no-save settings.

## Persistence and recovery

Each successfully processed message is persisted in its own transaction using
the existing adapter. A deterministic per-message run UUID is derived from
the ingestion UUID, account key and Gmail message ID. Before persisting, the
workflow checks for an existing committed decision for that derived run.
This avoids duplicate decision history on restart even when messages move
between pages or are returned in a different order. A different ingestion UUID
intentionally creates new decision history for the same message. Existing
messages from other workflows are not skipped.

An append-only checkpoint records pagination state after each page without
failures. Retrieval and processing failures are counted but not persisted as
completed, and the checkpoint is not advanced; `retryCurrentPage` indicates
that the same page needs another manual execution. A database or list failure
stops execution; previously committed messages remain. Resume using the
**same ingestion UUID, account key, query and limits**. An ingestion UUID is
bound to a configuration hash; a mismatch is rejected. Do not start concurrent
executions of the same ingestion. If a transaction's outcome is uncertain, the
existing decision is checked before any further insert. Checkpoints are
append-only, and conflicting page checkpoints fail explicitly.

Gmail search results and page tokens can change or expire as the mailbox
changes. Retrying a page may encounter a different selection and cannot
guarantee a complete snapshot or retry every formerly failed message.
Relative-date queries are particularly susceptible. Keep the approved query
stable, use an appropriate fixed date range when needed, and plan a separate
reconciliation process for mailbox completeness. No automatic retry or
notification is provided. If a workflow stops before its final report,
no-save settings mean progress since the last checkpoint may not be available
even though completed per-message transactions remain.

The final report contains page count and discovered, processed, persisted,
previously processed and failed counts, plus category and action totals.
`processed` counts message attempts not already recorded; `persisted` counts
new successful transactions; `previouslyProcessed` counts recognized prior
transactions; `failed` counts unsuccessful attempts left retryable. Category
and action totals include persisted and previously processed decisions but
exclude failures. Counters accumulate from successful checkpoints; attempts
on a failed page are not checkpointed and can be counted differently on
retry. In a concurrent identical retry, an attempt can be counted as both
processed and previously processed. `hasMore` indicates a remaining page;
also check `retryCurrentPage` before treating an ingestion as complete.
Reports do not include message IDs, page tokens, account keys, UUIDs or
message content.

## Local runtime and approval

The candidate uses the same restricted database role, package staging and
network arrangement as [live persistence](live-persistence.md). Before use,
[migration 2](../migrations/002_historical_ingestion.sql) must be separately
reviewed and approved, applied by the migration owner, and the application
role granted `SELECT, INSERT` on the two new tables. The migration and grants
were applied to the dedicated local application database after an approved
local development backup. Checkpoints
store sensitive Gmail pagination tokens, aggregate counts and an unkeyed
configuration hash; protect and retain them as sensitive metadata. Updated
package code must be staged separately before use. The role may read and
insert all application accounts; the database connection has no TLS. n8n
intermediate data, logs, editor state and backups can retain message content
even with no-save execution settings. Never pin live data or expose raw node
output. PostgreSQL stores message identity and decision history, not bodies,
subjects or sender addresses. A local development backup was created and its
archive listing verified; a restore test remains deferred.

Before any live test, separately approve the intended account, exact
`gmail.readonly` scope, query, date range, limits, retention and recovery plan.
Synthetic Task Runner verification used separate inactive, mock-only workflows,
including repeated manual page execution and item association. The historical
candidate was imported inactive and initially unbound. Before further live use,
separately approve credential binding and execution. Do not reuse the configured
Phase 1F-D run UUID as an ingestion UUID.

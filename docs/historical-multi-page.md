# Automatic multi-page historical ingestion

The inactive [parent](../workflows/09-mailflow-historical-multi-page.json)
and [one-page child template](../workflows/09-mailflow-historical-one-page.json)
extend the existing [historical ingestion](historical-ingestion.md) components.
One manual parent execution calls the child repeatedly, waiting for each
child to finish persisting and checkpointing its page before starting the
next. The parent stops at the configured maximum, Gmail exhaustion, or a
failure. The parent has only a manual trigger; the child has only a
subworkflow trigger. Both Gmail requests are GET-only.

The child runs as a separate subworkflow execution, so full Gmail responses
remain in that page's execution rather than being returned to the parent.
The parent retains pagination states and aggregate counters, not message
bodies, across pages. This is not a guarantee of erasure: n8n may retain
child execution data, logs, editor state, or backups. Both templates disable
execution-data saving, but retention must be reviewed in the actual deployment.
Page size is capped at 25 and the total discovery limit at 1,000.

## Local configuration

The parent export intentionally leaves its ingestion UUID, account key, query,
and child definition empty; the defaults are page size 25 and maximum 100.
Import it as inactive. In n8n 2.47.4 a database-selected child must be active;
to keep this design inactive, the parent uses the Execute Sub-workflow node's
**Define Below** source instead. Configure the child template locally, bind
the authorized read-only OAuth credential to both Gmail GET nodes, and supply
its complete JSON definition to the parent's **Run One Page** node. Keep the
configured definition and any credential references local; do not commit them.
Check the entire embedded definition, its no-save settings, and both bindings
before execution. An empty child definition is not ready to run.

Configure an explicit ingestion UUID, opaque account key, query, page size and
maximum in the parent. The existing restricted database connection, package
staging and migration 002 are required; see the
[runtime guide](historical-ingestion.md#local-runtime-and-approval). A
long-running JavaScript Task Runner may cache an older package after staging
changes, so verify its loaded exports before use. No staging, credential
binding or live execution is authorized by the reusable exports.

## Recovery and reporting

The child persists each successful message transaction separately and then
appends a checkpoint only when every message on that page has succeeded.
The next page is not requested before that checkpoint completes. On restart,
use the **same ingestion UUID and exact configuration**. Completed message
decisions are recognized using the existing deterministic per-message run
UUID, including after an uncertain commit or a partially completed page. A
different ingestion UUID intentionally creates new decision history.

The final report contains cumulative pages completed, discovered, processed,
persisted, previously processed and failed counts, category and action totals,
and a stop reason: `limit`, `exhausted`, `message_failure`, `list_failure` or
`pagination_failure`. It does not contain account identifiers, message IDs,
page tokens or content. Counts on a failed page reflect that attempt; its
page count remains the last committed page. On retry, already committed
messages count as previously processed. A list failure receives up to three
attempts, with a one-second delay between attempts. This includes non-transient
HTTP failures; message retrieval failures stop the page and require a manual
restart. Invalid Gmail list data is rejected before checkpointing. The parent
checks the child reply against the exact request state after the child may have
saved a checkpoint; a rejected reply stops the parent but does not undo that
checkpoint. Database and unexpected workflow errors surface as execution errors
and may prevent a final report; restart with the same configuration after
investigation.
If the maximum is reached on the same page that Gmail is exhausted, the stop
reason is `limit`; `stoppedAtLimit` separately indicates a continuation token
was present.

**Do not run the same ingestion concurrently.** There is no execution-wide
lock; checkpoint conflicts and per-message idempotency are not a substitute
for mutual exclusion. Gmail results and tokens can change or expire, and
retrying a page cannot guarantee a stable snapshot or that every formerly
failed message is returned. A limit counts listed messages, even if an
identity has appeared before. See the historical guide for further privacy,
counting, and reconciliation limitations.

Synthetic tests use isolated PostgreSQL and a separate n8n JavaScript Task
Runner with mock-only Gmail nodes. Before any live test, obtain separate
approval for the intended account, exact `gmail.readonly` scope, query,
limits, retention, recovery plan, credential binding and execution.

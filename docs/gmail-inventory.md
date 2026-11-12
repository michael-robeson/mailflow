# Gmail historical inventory: bounded prototype

**Legacy reference:** recovered from commit `9f25609`; not the current
item-state candidate. Keep it inactive. The instructions below are historical
and do not authorize import or execution.

The [workflow definition](../workflows/02-gmail-historical-inventory.json)
is a manual, inactive, unbound prototype with synthetic tests. Historical
notes conflict about whether it was imported or live-tested; that status
needs review. Do not import or execute it without separate approval.

## Data flow and limits

`Configure Inventory` sets an integer limit from 1 to 100, initially 100.
The workflow makes one Gmail `messages.list` GET request and then at most
that many `messages.get` GET requests. It requests IDs, labels, and the
`From`, `Subject`, `Date`, `List-Unsubscribe`, and `Precedence` headers with
`format=metadata`; it does not request bodies or attachments or perform
Gmail write operations. The existing generic OAuth2 credential uses
`gmail.readonly`; this scope itself permits more access than these requests
use. No OAuth scope or credential is included in the export.

The result is a sample, not a complete historical inventory. Only one page
is requested, the next-page token is not retained, and Gmail's response order
should not be assumed to be newest-first. There is no pagination,
checkpointing, retry strategy, or explicit rate limiting. API or malformed
response errors fail the run rather than intentionally producing a partial
report. Concurrent mailbox changes may also cause a request to fail.

The report counts messages by lowercased sender address, sorted by descending
count then sender. Missing, ambiguous, or unsupported sender formats count as
unknown. This deliberately simple parser can exclude valid unusual addresses;
lowercasing the entire address can merge addresses whose local parts differ
by case. Treat counts as review aids, not authoritative identities.

Each sender has per-message counts for a nonempty `List-Unsubscribe` header,
`Precedence` of `bulk`, `list`, or `junk`, and a no-reply/notification local
part. Any signal marks the sender as `potential_newsletter_or_automated`;
otherwise it is `no_signal`. Signals can be misleading or absent, and are
not proof that all messages from a sender are newsletters or automated.
Every sender has `safeToDelete: false`. The workflow never follows an
unsubscribe link or recommends automatic deletion.

The final report omits subjects, dates, labels, message IDs, and unsubscribe
header values, but those may appear in intermediate node outputs. Sender
addresses and counts are also sensitive. Do not pin, export, log, commit, or
share real execution output. No application-specific PostgreSQL tables or
metadata persistence are implemented. Future persistence requires an approved
schema, access controls, retention and deletion policy, separate from n8n's
internal tables. Execution saving off does not eliminate transient editor
output, logs, backups, or other copies.

## Controlled live test — only after approval

1. Import the JSON into local n8n as **02 - Gmail Historical Inventory**.
   Keep it inactive. Bind the existing generic OAuth2 credential with
   `gmail.readonly` to **both** HTTP nodes; do not change scopes.
2. In workflow settings verify manual, successful production, and failed
   production executions are each **Do not save**, and execution progress
   saving is **Off**. The export requests these settings, but a prior import
   did not preserve all save settings. Stop if the effective settings cannot
   be confirmed; see [execution retention review](gmail-read-only.md#execution-retention-review).
3. Optionally reduce `const limit = 100` in **Configure Inventory** to a
   smaller integer; never exceed 100. Verify no data is pinned and save the
   workflow settings. Confirm both HTTP nodes are GET requests before running.
4. Only after explicit live-test approval, execute the workflow manually once.
   Review the final report locally: `messagesAnalyzed` must be at most the
   configured limit, unknown counts and sender counts must sum to it, counts
   are sorted, and every sender has `safeToDelete: false`. An empty mailbox
   yields zero and an empty sender list. Do not paste personal data into chat
   or Git. If an error occurs, stop and investigate without exporting data.
5. Inspect the execution list and retention settings locally without exposing
   results. Saving off is not proof of secure deletion; handle any unexpected
   records through supported n8n controls, with approval. Do not modify the
   earlier connectivity workflow or its historical records as part of this test.

## Synthetic validation

With Node.js installed, run:

```sh
node --test tests/gmail-connectivity.test.cjs tests/gmail-historical-inventory.test.cjs
```

These tests evaluate code and inspect the JSON graph using synthetic inputs.
They do not prove n8n import, runtime behavior, OAuth, or live Gmail access.

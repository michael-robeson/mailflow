# Gmail paginated inventory: pagination and rate limiting

**Legacy references:** the exports `03-gmail-paginated-inventory.json`,
`03-gmail-paginated-inventory-fixed.json`, and
`03-gmail-paginated-inventory-safe-state-threading.json` are preserved as
historical references, not approved candidates. In particular, the `fixed`
variant has an unsafe state-threading assumption documented in the
[critical review](PHASE-1D-CRITICAL-REVIEW-FINDINGS.md). Keep them inactive;
do not import or execute them. The steps below are historical guidance.

The [workflow definition](../workflows/03-gmail-paginated-inventory.json)
is a manual, inactive, unbound prototype that extends the bounded inventory
with full Gmail pagination, explicit rate limiting, and configurable parameters.
It has synthetic tests but has not been imported or tested against live Gmail.
Do not execute it against Gmail without separate approval.

## Configuration and limits

`Configure Pagination` initializes configuration with validated, configurable parameters:

| Parameter | Default | Min | Max | Purpose |
| --- | --- | --- | --- | --- |
| `maxMessages` | 500 | 1 | 10000 | Absolute cap on total messages to retrieve and analyze |
| `pageSize` | 100 | 1 | 500 | Messages per Gmail API list request |
| `requestDelayMs` | 200 | 0 | 60000 | Millisecond delay between successive API requests |
| `maxRetries` | 3 | 0 | 10 | Maximum retry attempts for transient errors (reserved for future implementation) |
| `retryBaseDelayMs` | 1000 | 0 | 60000 | Base millisecond delay for exponential backoff (reserved for future implementation) |

All parameters are validated as integers within their ranges. The workflow
rejects invalid input before making any API calls.

## Pagination and API requests

The workflow continues fetching pages until one of the following occurs:

1. **Limit reached:** `maxMessages` accumulated unique message IDs
2. **No next token:** Gmail's `nextPageToken` is null or absent
3. **Empty response:** Gmail returns no messages

Each page is requested via `users.messages.list` with `maxResults` set to
`pageSize` and `pageToken` set to the previous response's continuation token.
Only unique message IDs are collected; duplicates across pages are detected
and rejected.

Between successive API requests, the workflow applies `requestDelayMs`
milliseconds of delay via `Rate Limit Delay`. This is explicit pacing, not
automated rate limiting via HTTP 429 responses. The delay is configurable
down to zero and up to 60 seconds.

### Expected request volume for 500 messages at default settings

- **List requests:** 5 pages of 100 messages each
- **Metadata requests:** up to 500 individual message GETs
- **Total API calls:** 505 (plus any retries in future versions)
- **Total elapsed time:** ~1-3 minutes (depends on network latency and n8n concurrency)
  - List-page pacing: ~1 second (5 pages × 200ms delay between requests)
  - Metadata requests: ~60-120 seconds for 500 requests (sent concurrently in batches of ~4-6 by n8n, not individually delayed)

## Rate limiting and retry strategy (design)

The current implementation provides **explicit request pacing for list-page pagination** via configurable `requestDelayMs` delay. **Metadata requests are not individually delayed** and are sent concurrently by n8n's HTTP batching (typically 4-6 parallel requests).

Future versions will implement bounded exponential backoff with jitter for
transient errors (HTTP 429, 5xx) and a distinct error handler for permanent
failures (HTTP 401, 403). The backoff will honor `Retry-After` headers when
provided by the Gmail API.

Permanent authorization failures will not be retried and will immediately
halt pagination with an error.

Current limitations:
- No automatic retry logic; a single failed request halts execution.
- No distinction between recoverable and permanent errors.
- Retry parameters (`maxRetries`, `retryBaseDelayMs`) are configured but not used.
- `requestDelayMs` applies only to list-page pagination loop, not to metadata requests.
- Metadata requests are concurrent and not individually paced.

## Aggregation and reporting

The workflow collects all unique message IDs from all pages, then batches
metadata requests for each ID. Results are aggregated to count senders,
detect newsletter/automation signals, and produce a final report.

The final report includes:

| Field | Type | Meaning |
| --- | --- | --- |
| `maxMessages` | integer | Configured limit |
| `pageSize` | integer | Configured page size |
| `pagination.pagesFetched` | integer | Number of list pages requested |
| `pagination.messagesDiscovered` | integer | Total message count from all list responses |
| `pagination.messageIds` | array | Unique message IDs collected (up to `maxMessages`) |
| `apiRequests` | integer | Total API calls made (list + metadata) |
| `retryCount` | integer | Retry attempts (currently always 0) |
| `messagesAnalyzed` | integer | Messages successfully retrieved and parsed |
| `unknownSenderCount` | integer | Messages with unparseable or missing `From` headers |
| `uniqueSenderCount` | integer | Number of distinct senders with valid addresses |
| `partial` | boolean | True if fewer messages were analyzed than collected IDs |
| `senders` | array | Sorted list of senders with counts and signals |
| `errors` | array | Accumulated error messages (reserved for future use) |

Each sender entry includes:

| Field | Type | Meaning |
| --- | --- | --- |
| `sender` | string | Lowercased, normalized email address |
| `count` | integer | Number of messages from this sender |
| `signals.listUnsubscribe` | integer | Messages with nonempty `List-Unsubscribe` header |
| `signals.bulkOrListPrecedence` | integer | Messages with `Precedence: bulk\|list\|junk` |
| `signals.noReplyAddress` | integer | Messages from addresses matching no-reply or notification patterns |
| `category` | string | `potential_newsletter_or_automated` if any signal > 0, else `no_signal` |
| `safeToDelete` | boolean | Always false; deletion is advisory only |

Senders are sorted by descending message count, then alphabetically by address.

### Privacy and data minimization

The report omits message subjects, dates, labels, message bodies, and
unsubscribe link URLs. Sender addresses and counts are sensitive. Do not pin,
export, log, or commit real execution output.

## Controlled live test — only after approval

1. Import the JSON into local n8n as **03 - Gmail Paginated Inventory**.
   Keep it inactive. Bind the existing generic OAuth2 credential with
   `gmail.readonly` to **both** HTTP nodes; do not change scopes.

2. In workflow settings verify manual, successful production, and failed
   production executions are each **Do not save**, and execution progress
   saving is **Off**. The export requests these settings, but a prior import
   did not preserve all save settings. Stop if the effective settings cannot
   be confirmed; see [execution retention review](gmail-read-only.md#execution-retention-review).

3. Optionally adjust configuration parameters in `Configure Pagination`:
   - Reduce `maxMessages` to 50 for initial testing
   - Keep other defaults unless testing specific scenarios
   - Never set `maxMessages` above 500 for the first test
   - Verify both HTTP nodes are GET requests before running

4. Only after explicit live-test approval, execute the workflow manually once.
   Review the final report locally:
   - `pagesFetched` should match the number of pages needed for the message count
   - `messagesAnalyzed` should equal `messagesDiscovered` (unless errors occurred)
   - Unknown counts and sender counts must sum to messages analyzed
   - Counts must be sorted descending by sender count
   - Every sender has `safeToDelete: false`
   - Empty mailbox yields zero and an empty sender list
   - Do not paste personal data into chat or Git

5. Inspect the execution list and retention settings locally without exposing
   results. Saving off is not proof of secure deletion; handle any unexpected
   records through supported n8n controls, with approval.

## Known limitations and planned work

### Current limitations
- No automatic retry; transient errors halt immediately
- Fixed request delay; no adaptive backoff
- No checkpointing or resumption across workflow executions
- No persistence to PostgreSQL or other storage
- All parameters are fixed at design time; no runtime input UI
- No pagination resumption; must restart from page 1 if interrupted
- No full-mailbox support; `maxMessages` is absolute and bounded

### Planned extensions
- Exponential backoff with jitter for transient errors
- Automatic retry distinguishing permanent from recoverable failures
- Checkpoints and resumable pagination
- PostgreSQL persistence for sender statistics and execution history
- Rule-based classification and recommendations
- Scheduled execution and report generation
- Optional AI-assisted sender classification
- Incremental processing of new messages

## Synthetic validation

With Node.js installed, run:

```sh
node --test tests/gmail-connectivity.test.cjs tests/gmail-historical-inventory.test.cjs tests/gmail-paginated-inventory.test.cjs
```

These tests evaluate code and inspect the JSON graph using synthetic inputs.
They do not prove n8n import, runtime behavior, OAuth, or live Gmail access.
Tests cover:
- Configuration validation and defaults
- Pagination logic across multiple pages
- Message ID deduplication
- Limit enforcement
- Empty mailbox handling
- Partial-page and final-page detection
- Sender aggregation and normalization
- Privacy (no sensitive data in output)
- Partial-result reporting
- HTTP request method and URL structure
- Rate-limit delay implementation
- Workflow graph connections

## Item-state export under review

`workflows/03-gmail-paginated-inventory-item-state.json` is a new inactive
export; it does not overwrite the earlier Phase 1D exports. Its `Configure
Pagination` Code node accepts `maxMessages`, `pageSize`, and `requestDelayMs`
from its input when supplied, otherwise it uses defaults of 500, 100, and
200 ms. The manual trigger does not provide a configuration form, so
adjust the defaults in that node before importing if a different limit is
needed.

Each list-page iteration fans its single current state item to a state
preservation branch and one read-only Gmail list request. The branches wrap
their payloads under distinct keys and feed `Pair Page State and Response`,
an n8n Merge node configured to combine by position with unpaired items
excluded. `Process Page Response` rejects anything other than one complete
pair. The loop cannot request the next page until that pair has been processed
and the delay node has returned its state. `pageSize` is stored at the root of
the state and is used directly in the HTTP URL.

Metadata state is also kept in a separate `requestContext` branch. Each
metadata HTTP response is paired with its request context before aggregation;
the sender report does not rely on the HTTP node preserving its input.
Both HTTP nodes explicitly use GET, request only message IDs or metadata
headers needed for classification, and capture HTTP status without retrying.
Non-2xx statuses become generic error entries; authorization failures are not
retried. Network/transport failures that produce no HTTP response can still
fail the n8n execution. The list delay applies between list-page requests,
not between individual metadata requests.

The exported-node tests can be run with:

```sh
node --test tests/gmail-paginated-inventory-item-state.test.cjs
```

They load and execute the actual Code-node JavaScript from the export against
synthetic inputs and statically inspect the graph. The in-test Merge pairing
is simulated. A separate inactive credential-free copy was subsequently
validated in n8n 2.47.4 against a local synthetic mock: three pages, 75 unique
IDs and metadata responses, and one normalized sender were reported. This
does not validate live Gmail or authorize importing or executing the candidate.

Recommended future controlled test, only after separate approval: set
`maxMessages=50`, `pageSize=25`, and verify two list requests, the second
request's `pageToken`, exactly 50-or-fewer unique IDs, and no more than 50
metadata requests. Separately test three synthetic pages and verify
`pagesFetched=3`, all accumulated IDs, and token progression across all three
iterations. Do not treat either synthetic test as authorization to import or
execute against Gmail.

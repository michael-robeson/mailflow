# Controlled live Gmail processing

Phase 1F-B provides an **inactive, manual, unbound** workflow:
[05 - Mailflow Live Gmail Processing](../workflows/05-mailflow-live-gmail.json).
Two separately approved local live runs were performed on November 13, 2026;
further live runs require separate approval. No application database tables,
notification delivery, or Gmail write operations are involved.

## What it does

The **Configure Live Processing** Code node contains two editable constants:
`limit`, an integer from 1 through 25 (default 25), and `query`, a Gmail
search string (default `newer_than:14d`). The list request includes the encoded `q`
parameter only when nonempty. It reads a single page and never follows a page
token. Gmail may return fewer than requested; the workflow is not a complete
mailbox inventory, and list order is not a documented sorting guarantee.
An oversized or malformed list, duplicate ID, or list request error stops the
execution rather than processing an uncertain batch.

The workflow requests each selected message with Gmail's `format=full`, which
includes metadata and message payload. It uses the shared `mailflow-pipeline`
normalizer, classifier, and notification policy, not separate classification
rules. Only inline MIME body data is decoded; externally stored attachment
bodies are not fetched. A message's Gmail ID stays in internal processing
items for association and future deduplication, but is not persisted by a
Mailflow table or included in the final report. There is no cross-execution
deduplication yet.

The final report contains a schema version and ordered results with ordinal
`messageNumber`, category, recommended action, matched rule IDs, explanation
codes, and status. It omits message and thread IDs, sender, subject, body,
and raw error details. Its aggregate `diagnostics` also counts normalized
messages with nonempty subjects, nonempty body text, valid sender addresses,
and any normalization warnings, plus decision categories and matched rule
IDs. Counts of normalized fields use only messages whose normalization
completed; retrieval failures are not treated as empty messages. Category
counts include safe `other` decisions for retrieval and processing errors.
Rule counts count each matched rule, so their sum can exceed the number of
messages. These statistics are derived from the same normalization and
classification used for the decisions; they do not include raw values.
Even aggregate statistics can reveal sensitive mailbox characteristics.
An individual HTTP or malformed-response failure
produces `retrieval_error` / `none`; a processing exception produces
`processing_error` / `none`. Other messages continue. A failed list request
or invalid response association stops the workflow instead of claiming success.
The empty-mailbox path produces an empty report. Recommendations are not
notifications and are not scheduled.

## OAuth and manual preparation

Use the existing generic **OAuth2 API** credential described in
[Gmail read-only connectivity](gmail-read-only.md#google-cloud-and-n8n-oauth),
with Gmail API enabled and the scope
`https://www.googleapis.com/auth/gmail.readonly`. This scope permits reading
message contents, and is restricted by Google. Confirm the correct Google
account, test-user status, consent, and credential health locally; testing-mode
credentials may expire, and automatic refresh has not been verified. Do not
grant broader access to fix an OAuth error.

After separate authorization to import and bind, select that credential in
both **List Gmail Messages** and **Get Full Gmail Message**. The repository
export deliberately has no credential binding. Keep the workflow inactive,
inspect both nodes as literal GET requests to the Gmail API, review `limit`
and `query`, and do not pin any output. Do not execute it until the separate
live-run approval is granted.

## Runtime package configuration

The Phase 1F-A local test used a temporary, read-only `/tmp` bind mount and
`NODE_FUNCTION_ALLOW_EXTERNAL=mailflow-pipeline`. `/tmp` can be removed on
reboot, the staging copy can become stale, and the repository's default
[Compose configuration](../compose.yaml) does not install or mount the
package. The currently mounted staging copy and imported workflow can lag
behind repository changes; rebuild the package and separately update the
imported workflow before any approved test that uses new code.

For a reproducible local development setup, create a fresh disposable staging
directory outside the private repository and home, and copy **all** current
`lib/*.cjs` files and `lib/package.json` into its `package` subdirectory.
For example, in Bash from the repository root:

```bash
STAGING="$(mktemp -d /tmp/mailflow-package.XXXXXX)"
mkdir "$STAGING/package"
cp lib/*.cjs lib/package.json "$STAGING/package/"
chmod 755 "$STAGING" "$STAGING/package"
printf 'Package directory: %s/package\n' "$STAGING"
```

In a local Compose override outside the repository, substitute that absolute
package directory for `STAGED_PACKAGE_DIRECTORY`:

```yaml
services:
  n8n:
    environment:
      NODE_FUNCTION_ALLOW_EXTERNAL: mailflow-pipeline
    volumes:
      - STAGED_PACKAGE_DIRECTORY:/usr/local/lib/node_modules/n8n/node_modules/mailflow-pipeline:ro,z
```

The `:z` label is for an SELinux-enabled host and applies only to the
disposable package directory. Never relabel the repository, home, or existing
volumes, disable SELinux, or broaden the allowlist. On other hosts omit `,z`
if inappropriate. Apply the override with the existing Compose file only after
approval to recreate n8n; check service health and the actual Code runner's
package resolution. Refresh the staging copy and restart the relevant n8n
runner after package changes; do not overwrite a package in use. External
Task Runners need the package and allowlist in their own environment.

## Privacy and execution retention

The sanitized report is not a guarantee that message contents are absent
elsewhere. Full responses, message IDs, headers, body text or encodings, and
possibly HTTP error details can appear in intermediate node data, the editor,
logs, n8n execution records, backups, or pinned data. Do not copy real data to
Git, chat, logs, or issue reports.

The export requests `saveManualExecutions: false`,
`saveDataSuccessExecution: none`, `saveDataErrorExecution: none`, and
`saveExecutionProgress: false`. After import, check the effective workflow and
instance settings in n8n, avoid pinning data, and verify retention behavior
locally before relying on it. These settings do not erase existing records,
editor state, logs, backups, or all transient copies. The n8n CLI can emit
intermediate data even when the final report is sanitized. Historical records
must not be deleted without separate approval; see the
[retention review](gmail-read-only.md#execution-retention-review).

## Verification

Offline synthetic tests cover list bounds, query encoding, the workflow's
read-only graph, response association, retrieval and processing failure
isolation, and report privacy:

```sh
node --test tests/mailflow-live-gmail.test.cjs tests/mailflow-synthetic-pipeline.test.cjs
```

They simulate n8n node inputs and do not by themselves prove OAuth, Gmail
behavior, runner item association, or execution retention in a live run.

On November 13, 2026, an approved local n8n 2.47.4 CLI run used the query
`newer_than:14d` and processed 25 messages. All 25 produced
`other` / `none` with `insufficient_evidence`; no retrieval or processing
errors were reported. The report's category counts alone do not establish
whether those classifications were appropriate. No actual per-message
failure occurred in this run, so failure isolation was exercised in
synthetic tests, not demonstrated with a live failure.

The diagnostic counts added later cannot be recovered for the first run: its
execution data was discarded. Google documents root `payload.headers` and
MIME `parts` in its [message resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages);
the live adapter passes the full response's message body to the normalizer.
Synthetic regressions verify that plain-text and HTML body parts and root
headers reach the existing classifier. They do not prove which content was
present in the 25 live messages. An encoded-word subject can currently remain
encoded, so a nonempty subject count alone does not establish that the text
was meaningful to the classifier. External body parts are not fetched, and
duplicate headers or malformed encodings can also reduce available text.

`newer_than:14d` limits age, not topic; a single 25-message page can consist
entirely of unrelated mail. A second separately approved diagnostic run used
`newer_than:14d {interview "application received" "job alert"}` and processed
25 messages. All 25 had nonempty normalized subjects and bodies, valid sender
addresses, and no normalization warnings. Five matched `job_alert_digest`
and received `job_alert` / `weekly`; 20 received `other` / `none` with
insufficient evidence. No retrieval or processing errors were reported.
These results show that normalization delivered nonempty text in the second
sample and that the classifier matched some messages; they cannot establish
why the first sample was all `other` or whether the other 20 decisions were
correct. The narrow query can still return irrelevant mail or miss legitimate
job-search messages and is not a representative accuracy sample.

The local credential's configured and granted scopes were checked as
`gmail.readonly`, and a read-only profile check matched the intended account.
The imported workflow remained inactive. The no-save CLI execution was
soft-deleted by n8n and its execution-data field was an empty structure on
inspection for each run. This observation does not establish that editor state, logs,
transient data, or backups are empty, nor does it guarantee retention behavior
for other execution modes or future runs.

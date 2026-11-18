# Synthetic n8n pipeline integration

`workflows/04-mailflow-synthetic-pipeline.json` is an inactive, manual,
synthetic-only workflow. It creates a batch of synthetic Gmail API-shaped
messages and sends them through the shared normalizer, classifier, and
notification policy using `lib/pipeline-adapter.cjs`. It contains no Gmail,
HTTP, scheduling, persistence, or notification-delivery nodes.

The separate [provider-neutral synthetic pilot](provider-neutral-synthetic-pilot.md)
starts with already-normalized synthetic messages and exercises the same
classifier and policy without a Gmail-shaped payload.

The adapter calls the Phase 1E modules directly. It keeps message association
inside each per-message call and exposes only a one-based `messageNumber` in
the report. Each report result contains the category, recommended action,
matched rule IDs, explanation codes, and status; message and thread IDs,
sender, subject, and body are not copied to the report. An individual
processing exception becomes an `other` / `none` result with
`message_processing_failed`, and later batch entries continue.

## Supported n8n module loading

The n8n Code node does **not** make arbitrary CommonJS modules available by
default. [n8n's Code node module configuration](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/configuration-examples/enable-modules-in-code-node/)
documents `NODE_FUNCTION_ALLOW_EXTERNAL` for external modules installed in
`n8n/node_modules`; the allowlist should name only the needed package. The
project packages its existing `lib/` files as the private local package
`mailflow-pipeline` and the workflow uses exactly
`require('mailflow-pipeline')`. It does not duplicate module logic or load an
arbitrary path.

For the repository's Docker image layout, the local setup is to stage the
contents of `lib/` in a disposable directory outside the private repository
and home directory, then mount that package directory read-only at
`/usr/local/lib/node_modules/n8n/node_modules/mailflow-pipeline` and set
`NODE_FUNCTION_ALLOW_EXTERNAL=mailflow-pipeline` on the n8n service. If Code
nodes run in Task Runners, set the allowlist in the runner environment as
well. The module path is specific to the current n8n image; verify it against
`require.resolve('n8n/package.json')` when changing the image. Keep the mount
read-only and do not broaden the allowlist to `*`. On SELinux-enforcing hosts,
use a container-compatible label such as Docker's `:z` on the disposable
staging directory only; do not relabel the repository or existing volumes.
The package entry point also exports the Phase 1F-B live-response adapter;
stage all current `lib/*.cjs` files and `lib/package.json`, not only the
files used in the original Phase 1F-A test. See the
[live workflow runtime configuration](live-gmail-processing.md#runtime-package-configuration).

## Local runtime verification

On November 13, 2026, the inactive export was imported into the local n8n
2.47.4 instance and executed manually using the n8n CLI and its JavaScript
Task Runner. The package was mounted read-only from a disposable `/tmp`
staging directory with `:z`; a temporary Compose override set the narrowly
scoped allowlist. The default CLI task-broker port was already used by the
running server, so the one-off CLI process used a different local broker
port. The override and staging directory are local runtime configuration,
not part of the repository's default Compose configuration, and the staging
directory may disappear on reboot.

The three synthetic messages produced `interview_request` / `immediate`,
`application_confirmation` / `daily`, and `job_alert` / `weekly`. A
separately imported inactive test variant inserted a throwing synthetic
message; it produced `other` / `none` with `message_processing_failed`, and
both subsequent messages succeeded. The reports were checked for message
and thread IDs, headers, body text and encoded body data. Neither workflow
uses Gmail, delivery, or schedule nodes.

CLI output can include intermediate node data as well as the final report,
and executions can be stored in n8n's database. This test used synthetic
data only. The offline tests also execute the exported Code-node snippets
with a controlled local package resolver.

## Report example

```json
{
  "schemaVersion": "1.0",
  "results": [
    {
      "messageNumber": 1,
      "category": "interview_request",
      "action": "immediate",
      "matchedRuleIds": ["interview_invitation"],
      "explanationCodes": ["positive_rule_matched", "default_action_selected"],
      "status": "decided"
    }
  ]
}
```

The report is a recommendation only. No notification is sent or scheduled.

Run the end-to-end offline simulation with:

```sh
node --test tests/mailflow-synthetic-pipeline.test.cjs
```

## Opt-in versioned standalone pipeline

`lib/versioned-pipeline.cjs` exports `processVersionedBatch` as a separate
M1 entry point. It requires an account key, an explicit persisted configuration
revision (or `null` for built-in defaults), a run UUID, a replay flag, an
explicit `makeCurrent` choice for each message, and an injected
`createVersionedPersistenceAdapter` instance. It normalizes and classifies
each message, assigns a system tag for the matching existing classification
category, evaluates the v2 category policy, then persists the complete batch
through one transactional adapter call. Account-defined tags can be added or
removed only through the existing explicit correction API.

The seven matched categories use their existing category IDs as built-in
tag IDs and the corresponding classifier rule IDs as provenance;
insufficient-evidence messages receive no built-in tag. Account-defined tags
cannot reuse those built-in IDs. Tags do not affect policy selection.
Historical batches must explicitly set every `makeCurrent`
to `false`; selecting a historical evaluation later requires the separate
explicit current-selection API. Retrying an identical batch with the same run
UUID returns the original evaluation IDs. A failed transactional write leaves
no batch, evaluation, tag assignment, or current-effective update.

This API is additive and is not called by `processSyntheticBatch` or any
checked-in n8n workflow. It does not send notifications, schedule delivery, or
modify Gmail. Its synthetic tests use an injected offline persistence stub;
transactional guarantees are covered separately by the disposable PostgreSQL
integration tests.

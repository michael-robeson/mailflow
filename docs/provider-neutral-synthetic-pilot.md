# Provider-neutral synthetic pilot

`workflows/10-mailflow-provider-neutral-synthetic-pilot.json` is an inactive,
manual-only n8n workflow that exercises the shared classifier and policy using
synthetic messages already in Mailflow's normalized schema. It contains no
provider API payloads, HTTP or Gmail nodes, credentials, persistence, delivery,
or schedule trigger. The fixture and report use synthetic data only.

The workflow calls `processNormalizedBatch` from the allowlisted
`mailflow-pipeline` package. This path begins after provider-specific
retrieval and normalization; it does not implement or validate a connection,
authentication, permission scope, or normalizer for any external provider.
The report includes only ordinal decisions, categories, recommended actions,
rule IDs, explanation codes, and statuses. It excludes message IDs, sender,
subject, and body.

The offline test executes the exported Code-node snippets with a controlled
local package resolver:

```sh
node --test tests/mailflow-synthetic-pipeline.test.cjs
```

## Recorded n8n runtime result

The inactive workflow was imported into the persistent n8n 2.47.4 instance and
executed once with the synthetic fixture through a one-shot Compose container.
The Code node resolved the staged `mailflow-pipeline` package. The execution
completed successfully with `interview_request` / `immediate`,
`application_confirmation` / `daily`, and `job_alert` / `weekly`. The workflow
remained inactive.

The n8n database contains one workflow row for this pilot and one successful
execution row; CLI execution data was stored despite the workflow's
`saveManualExecutions: false` setting. The execution contains only the
synthetic fixture and decisions. The Mailflow application database was not
written by this workflow and contains no messages with this pilot's synthetic
IDs. No provider requests were made.

For a future provider pilot, first select the provider and review its
least-privilege read-only permissions. Implement and test a provider-specific
adapter that maps synthetic provider fixtures into the existing normalized
schema before introducing any credentials or live requests. Keep this
workflow inactive; a live provider run requires separate, task-specific
approval.

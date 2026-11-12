# Extending Mailflow

This guide describes possible future development, not implemented
functionality. Keep changes proportionate to a personal local tool, maintain
the [safety model](safety-rules.md), and document decisions before adding
automated actions.

## Classification rules

The existing [`categories.json`](../config/categories.json) and
[`default-rules.json`](../config/default-rules.json) contain empty arrays.
They are placeholders: no current workflow loads them and no schema or
precedence rules have been established.

Before adding categories or sender rules, define and validate a schema,
versioning and migration strategy, deterministic precedence, protected
senders, and conflict handling. Test with synthetic messages and provide
explanations and a dry run. Decide explicitly how rules are loaded and
whether PostgreSQL should store user-specific changes; do not assume editing
the JSON files alone changes behavior.

## New workflows

Start with a narrow purpose and minimum permissions. Create and test in n8n
using synthetic or redacted fixtures, including empty inputs, errors, retries,
and limits. Document triggers, permissions, inputs, outputs, failure handling,
and any required approval. Export a sanitized JSON definition into
[`workflows/`](../workflows/), remove credential references and pinned or
execution data, review the diff, and version it in Git when approved.
[Local setup](setup.md#workflow-import-execution-and-versioning) describes the
import/export process. Never commit actual message data.

## Integrations

Potential additions include Microsoft Outlook via Microsoft Graph, Google
Drive, a local filesystem, Slack, Telegram, SMS providers, calendars, and
other APIs. Each needs its own threat and permission review:

- Select read-only scopes where possible; request write or send permissions
  separately and only when a specific approved feature needs them.
- Store credentials in n8n or an appropriate secret manager, never in
  workflow exports. Plan for token refresh, revocation, provider quotas, and
  least-privilege service accounts where applicable.
- Treat destinations as possible data disclosures. Notifications and external
  APIs must receive only the minimum user-approved information.
- Local filesystem nodes run in a container context: carefully restrict
  mounts and file permissions rather than assuming host paths are available.

## Optional AI

A future model could assist with categorization, recurring sender analysis,
cleanup recommendations, natural-language daily summaries, or learning
preferences from feedback. Explicit deterministic rules and protected
categories should take precedence over uncertain model output; use confidence
thresholds, explanations, fallback behavior, and human review rather than
letting a model autonomously delete or hide mail.

Evaluate whether data can remain local, what metadata or content an external
provider receives, retention and training policies, consent, model quality,
latency, usage costs, and failure modes. Minimize and redact data sent to any
model. No AI integration is currently configured.

## Optional user interface

A future React frontend and FastAPI backend could present sender statistics,
recommendations, approval workflows, rule management, audit history, and
cleanup progress. This is a possibility, not a current dependency or
requirement. A backend would need explicit authentication, authorization,
data ownership, and an API boundary; avoid adding it until the workflow
needs justify the complexity.

## Cloud deployment

The current application runs locally; Google Cloud is used only for Gmail
API and OAuth configuration. A future Google Cloud deployment could run n8n
in a container environment, use persistent PostgreSQL such as Cloud SQL, and
store secrets in Secret Manager. It would also need HTTPS, the correct public
OAuth callback, restricted access, monitoring, log redaction, tested backups
and recovery, patching, and a cost budget.

Do not assume Cloud Run suits every n8n execution model. Evaluate webhook
availability, scheduling and always-on requirements, request and execution
lifetimes, background workers, concurrency, persistent files, database
connections, and graceful shutdown against the selected deployment mode.
Queue workers or long-running workloads may require different hosting.

| Local Docker | Small Google Cloud deployment |
| --- | --- |
| Direct control and low hosting cost, but depends on the local machine being available. | Potentially more available; incurs infrastructure, networking, monitoring, and operational costs. |
| Named volumes need independent backups and restore tests. | Managed persistence can reduce some operations, but backup, recovery, permissions, and cost still require explicit design. |
| Localhost HTTP is intentionally not public. | HTTPS, access controls, public callback configuration, and exposure risks require careful review. |

No cloud infrastructure is provisioned by this guide.

## Architectural evolution

First prove the read-only workflow and build a safe inventory. Add
deterministic rules, explicit approvals, audit, and tested recovery only as
needed. If usage later grows beyond a personal tool, consider stable
provider adapters, versioned data models, isolated user credentials, and
deployment automation. Defer multi-user and platform abstractions until real
requirements justify their complexity.

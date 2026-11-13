# Mailflow

## What is Mailflow?

Mailflow is a personal email automation project designed to reduce inbox
clutter, surface important messages, organize email, and recommend cleanup
while keeping the user in control. It uses n8n to orchestrate workflows. Gmail
is the first integration; supporting other email providers is a future goal.

## The problem we're solving

Newsletters, promotions, and notifications can bury important messages.
Years of accumulated mail make sorting, archiving, and deciding which
subscriptions are still useful repetitive and difficult. Generic rules also
miss personal preferences, and automatic deletion or hiding can cause harm.

For example, someone might receive 50 messages a day, of which 40 feel
low-value. These are hypothetical numbers, not measured Mailflow results.

## Our solution

The local foundation runs n8n and PostgreSQL in Docker Compose. A read-only
Gmail connectivity workflow is **in progress**: historical notes report a
local read-only test returning metadata for five messages. The sanitized
definition is unbound, and automatic OAuth token refresh remains unverified.
Historical execution data may remain; see the
[retention review](docs/gmail-read-only.md#execution-retention-review).

The [bounded inventory](docs/gmail-inventory.md) and older
[paginated inventory](docs/gmail-paginated-inventory.md) exports are
legacy references. The corrected item-state export has synthetic tests and
was validated against a local mock in n8n 2.47.4, not live Gmail. Keep all
workflows inactive; import or live execution requires separate approval.

A standalone [Gmail message normalizer](docs/gmail-normalization.md) converts
synthetic full-format responses into structured text without contacting Gmail.
A standalone [deterministic classifier](docs/email-classification.md) can
classify normalized messages offline as a review aid.
A standalone [notification action policy](docs/notification-policy.md) maps
classification results to recommended timing without delivering notifications.
An inactive [synthetic n8n pipeline](docs/synthetic-pipeline.md) demonstrates
the complete normalization-to-policy flow and has been tested with synthetic
data in the local n8n runtime.
An inactive [controlled live Gmail workflow](docs/live-gmail-processing.md)
has had two separately approved read-only runs of 25 messages; further live
runs require separate approval.

The following are **planned, not implemented**:

- Full-mailbox inventory, checkpoints, and unread-message reports.
- Configurable classification rules, labels, and organization.
- Human-approved bulk cleanup and incremental handling of new messages.
- Daily summaries, weekly recommendations, and feedback-driven preferences.
- Optional AI-assisted classification, audit records, and recovery mechanisms.

There are no automated classification workflows or application-specific tables.
See the [architecture](docs/architecture.md) for what exists and what is
proposed.

## Design principles

- **Privacy first:** minimize collected data and protect credentials.
- **Read-only initially:** inspect mail before considering changes.
- **Human in the loop:** require explicit approval for consequential actions.
- **Incremental automation:** start small and expand only after verification.
- **Explainability:** make future classifications and recommendations traceable.
- **Reversibility:** favor reversible actions where technically possible.
- **Configuration over hardcoding:** evolve rules and categories deliberately.
- **Separate orchestration and state:** use n8n for workflows and PostgreSQL
  for persistence, with application-specific data models designed later.
- **Practical extensibility:** add integrations without unnecessary complexity.

## Quick start

1. Obtain access to the private repository and clone it.
2. Install Docker with Compose, Git, and OpenSSL; prepare local secrets.
3. Start the services and open [n8n](http://localhost:5678).
4. To test Gmail, configure a Google Cloud OAuth client and import the sample
   workflow; authorization and credential binding are local and interactive.

Follow [local setup](docs/setup.md) for verified commands and prerequisites,
and [Gmail setup](docs/gmail-read-only.md) for the read-only OAuth details.
The workflow must be imported and its credential bound locally.

## Quality gates

Pull requests targeting `develop` run offline synthetic tests, validate workflow
JSON and safety rules, and scan repository files for common secret patterns.
Install the local pre-commit hook and run the same checks as described in
[local validation](docs/setup.md#local-validation-and-git-hooks).

## Project roadmap

| Stage | Status | Scope |
| --- | --- | --- |
| Phase 1A: local foundation | Complete | Local Docker Compose, n8n, PostgreSQL, and persistent volumes. |
| Phase 1B: Gmail connectivity | In progress | Historical notes report a local read-only test; token refresh and retention after changes remain unverified. |
| Phases 1C–1D: inventory | In progress | Legacy references and an item-state candidate with offline and mock-runtime validation; live candidate execution requires approval. |
| Phase 1E: offline email decision components | Implemented | Normalization, deterministic classification, and notification action policy; no workflow or notification delivery. |
| Phase 1F-A: synthetic pipeline integration | Implemented | Inactive test workflow verified with synthetic data in n8n; module loading requires explicit local configuration. |
| Phase 1F-B: controlled live Gmail processing | In progress | Inactive read-only workflow tested twice against 25-message samples; further live runs require separate approval. |
| Later: inventory and classification | Planned | Full inventory, persistence, configurable rules, and incremental processing. |
| Later: approved actions and recommendations | Planned | Reviewed cleanup, audit and recovery, summaries, personalization, and optional AI. |

Later stages describe intended capabilities, not a committed schedule or
implemented features.

## Documentation index

- [Local setup and operations](docs/setup.md)
- [Gmail read-only connectivity](docs/gmail-read-only.md)
- [Bounded Gmail inventory (legacy)](docs/gmail-inventory.md)
- [Paginated Gmail inventory](docs/gmail-paginated-inventory.md)
- [Gmail message normalization](docs/gmail-normalization.md)
- [Deterministic email classification](docs/email-classification.md)
- [Notification action policy](docs/notification-policy.md)
- [Synthetic n8n pipeline integration](docs/synthetic-pipeline.md)
- [Controlled live Gmail processing](docs/live-gmail-processing.md)
- [Architecture and data flows](docs/architecture.md)
- [Safety model](docs/safety-rules.md)
- [Extensibility and future deployment](docs/extensibility.md)

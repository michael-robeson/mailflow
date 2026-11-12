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
Gmail connectivity workflow is **in progress**: a sanitized, unbound
definition requests metadata for at most five messages. Its live execution
has not yet been verified. One local OAuth authorization was reported
successful; that does not verify the workflow or other installations.

The following are **planned, not implemented**:

- Historical inventory, sender-frequency and unread-message reports.
- Rule-based classification, configurable labels, and organization.
- Human-approved bulk cleanup and incremental handling of new messages.
- Daily summaries, weekly recommendations, and feedback-driven preferences.
- Optional AI-assisted classification, audit records, and recovery mechanisms.

There are no active classification rules or application-specific tables.
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

## Project roadmap

| Stage | Status | Scope |
| --- | --- | --- |
| Phase 1A: local foundation | Complete | Local Docker Compose, n8n, PostgreSQL, and persistent volumes. |
| Phase 1B: Gmail connectivity | In progress | Read-only OAuth reported authorized locally; workflow definition prepared, live test and publication pending. |
| Later: inventory and classification | Planned | Inventory, reporting, configurable rules, and incremental processing. |
| Later: approved actions and recommendations | Planned | Reviewed cleanup, audit and recovery, summaries, personalization, and optional AI. |

Later stages describe intended capabilities, not a committed schedule or
implemented features.

## Documentation index

- [Local setup and operations](docs/setup.md)
- [Gmail read-only connectivity](docs/gmail-read-only.md)
- [Architecture and data flows](docs/architecture.md)
- [Safety model](docs/safety-rules.md)
- [Extensibility and future deployment](docs/extensibility.md)

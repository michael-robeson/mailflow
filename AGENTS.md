# Mailflow contributor guide

Mailflow is a personal email orchestration project. It uses n8n for workflow
orchestration, PostgreSQL for n8n and separate application state, and
JavaScript (CommonJS `.cjs`) for reusable processing logic. Gmail is the
current provider integration. This repository does not use .NET Aspire.

## Architecture and status

- n8n coordinates workflows; standalone modules in `lib/` normalize Gmail
  messages, classify them, evaluate notification policy, and persist decisions.
- Classification and policy modules can run offline. A policy decision is a
  recommendation, not a notification, schedule, or Gmail action.
- n8n's internal PostgreSQL database is separate from the opt-in Mailflow
  application database. Application schema changes use numbered SQL
  migrations in `migrations/`.
- Checked-in workflow JSON is a sanitized definition, not the state of an
  imported workflow in n8n. Runtime credential bindings, activation, drafts,
  execution data, and other local state are separate. Editing an export does
  not update an imported workflow.
- Treat documentation status labels as authoritative: implemented offline
  behavior, workflow candidates, and proposed capabilities are distinct.
  Do not describe planned behavior as implemented. In particular, automated
  cleanup, approval gates, notification delivery, and application audit
  writing are not implemented.

## Repository map and canonical guidance

- `workflows/` — versioned n8n workflow exports; review status and import
  guidance in [docs/setup.md](docs/setup.md).
- `lib/` — reusable JavaScript processing and persistence modules.
- `migrations/` — ordered application-database migrations; never edit a
  migration that has been applied.
- `config/` — currently empty placeholders, not loaded runtime rules.
- `tests/` — offline synthetic tests and separate integration tests.
- `scripts/` — validation, hook setup, and opt-in database test utilities.
- `.github/skills/verify-workflow/SKILL.md` — reusable workflow verification
  procedure; use synthetic data and distinguish simulation from actual n8n
  behavior.

Read [README.md](README.md) for project status and the documentation index.
Use [docs/architecture.md](docs/architecture.md) for system boundaries and
current-versus-planned data flows, [docs/safety-rules.md](docs/safety-rules.md)
for the safety model, and [docs/setup.md](docs/setup.md) for setup, workflow
versioning, and local validation. Component-specific guidance:

- [Gmail access and retention](docs/gmail-read-only.md)
- [Classification](docs/email-classification.md)
- [Notification policy](docs/notification-policy.md)
- [Application persistence](docs/postgres-persistence.md)
- [Live Gmail processing](docs/live-gmail-processing.md)
- [Historical ingestion](docs/historical-ingestion.md)

Follow those documents for detailed procedures; do not duplicate them here.

## Non-negotiable safety constraints

- Do not access live Gmail, authorize a Gmail credential, or perform a live
  Gmail operation without explicit task-specific approval. Read-only scope
  does not make an operation implicitly authorized.
- Keep every checked-in workflow inactive, unbound, and sanitized. Do not
  import, bind credentials, activate, publish, or execute a workflow unless
  the task explicitly authorizes that operation. Never commit credentials,
  tokens, real email data, pinned data, or execution output.
- Do not expose secrets in source, workflow exports, logs, test output, chat,
  or command output. Treat message IDs, headers, decision metadata, database
  contents, and n8n execution state as sensitive too.
- Do not perform destructive database operations without explicit approval.
  This includes deleting or overwriting data, changing persistent volumes,
  dropping or reinitializing databases, and deleting execution records or
  backups. Never point application migrations or tests at n8n's database.
- Do not silently broaden Gmail permissions or introduce Gmail write actions.
  Mutating mail operations are outside the current safety boundary.
- A sanitized workflow report or disabled execution saving does not guarantee
  that sensitive data is absent from intermediate n8n state, logs, or backups.
  Review the relevant safety and workflow documentation before proposing
  changes that process real mail.

## Changes and verification

- Make small, focused changes; preserve existing behavior and conventions.
  Keep workflow exports, reusable code, and migrations in their established
  locations. Do not add frameworks or abstractions without a demonstrated
  need.
- For behavior changes, add or update focused synthetic tests that exercise
  the requested behavior. Use existing helpers and test patterns.
- From the repository root, the documented offline checks are:

  ```sh
  node scripts/validate.cjs
  node --test tests/*.test.cjs
  ```

  They do not contact Gmail or require n8n, containers, or a database.
  The PostgreSQL integration test uses disposable containers and is separate;
  consult [docs/setup.md](docs/setup.md) and
  [docs/postgres-persistence.md](docs/postgres-persistence.md) before running
  it; running it requires explicit approval because it creates and removes
  disposable containers. Do not run live or deployed integration tests unless
  specifically authorized.
- The validator's `--staged` mode checks staged file contents. The pre-commit
  hook runs tests against the working tree, so stage related code and tests
  together and verify the intended snapshot. CI remains an independent gate.
- Report the exact checks performed and distinguish verified behavior from
  behavior not exercised. Do not claim static validation proves workflow
  runtime behavior or live-provider behavior.

# ADR-0003

## Title

Processing, classification, and policy boundaries

## Status

Accepted (retrospective)

## Context

In the current live-workflow candidates, n8n retrieves Gmail responses.
Reusable JavaScript modules then provide bounded response handling,
normalization, classification, policy evaluation, and—where configured—
persistence. The boundaries are represented by versioned data contracts and
standalone modules:

- `gmail-live.cjs` validates Gmail list and message responses and creates a
  sanitized report. `gmail-normalize.cjs` itself performs no Gmail access; it
  converts a supplied full-format message into a normalized representation.
- `email-classify.cjs` applies deterministic phrase-based rules to normalized
  subject, body, and limited sender-role information. It returns a versioned
  category, rule identifiers, explanation codes, and status. It is a review
  aid, not a guarantee of intent.
- `notification-policy.cjs` validates a classification and optional
  per-category overrides, then returns a versioned action recommendation.
  Its output contains no message identifier or content.
- `pipeline-adapter.cjs` composes normalization, classification, and policy
  evaluation. Live and historical persistence adapters separately map
  processed results to transactional application-database records.
- Robecruit is mentioned only as a possible future consumer of validated
  policy overrides. There is no current Robecruit integration, user preference
  store, or notification transport in these modules.

The repository demonstrates these components with offline synthetic tests and
a synthetic n8n workflow. These boundaries are evident in the implementation;
the available documentation does not establish that independent testing or
future reuse was the original historical reason for choosing them.

## Decision

- Keep Gmail retrieval/orchestration separate from normalization. The
  normalizer accepts Gmail-shaped input and does not make provider requests.
- Keep deterministic classification separate from notification policy.
  Classification identifies supported categories and evidence; policy maps
  valid classifications to `immediate`, `daily`, `weekly`, or `none`, with
  fail-closed handling for unsupported or invalid inputs.
- Treat those policy actions as recommendations only. `immediate` does not
  send an alert; `daily` and `weekly` do not schedule digests. Delivery,
  scheduling, Gmail modification, and approval flows are outside the current
  implementation.
- Compose the modules through the shared pipeline rather than maintaining
  duplicate classification and policy logic in workflow definitions.
- Keep persistence as a separate adapter and transaction boundary. Current
  persistence stores identifiers, timestamps, categories, statuses, and
  explanation codes; it does not deliver notifications or perform Gmail
  actions. The `action_log` schema is future-facing and has no current writer.
- Any future downstream consumer, including Robecruit, must integrate through
  explicit versioned contracts and validated preferences. Do not imply a
  current consumer or copy message content into a policy decision.

## Alternatives considered

Monolithic workflow-node logic, coupling classification to notification
transport, or directly coupling policy to a downstream product are possible
contrasts. The repository does not document these as formally evaluated
historical alternatives.

## Consequences

- Normalization, classification, and policy can be tested independently with
  synthetic inputs and then composed in pipeline tests. Their contracts can
  be reused without requiring Gmail access or a delivery service.
- Separate interfaces provide a clear extension point for a future consumer
  while keeping consumer preferences and transport out of classification.
  Future integrations still need explicit contract-version, validation,
  privacy, and failure-handling decisions.
- Deterministic classification remains heuristic and can misread quoted,
  negated, unfamiliar, or conflicting content. Policy recommendations do not
  establish classification correctness or authorize an action.
- Persistence is a separate side effect and stores sensitive message
  identifiers and decision metadata. Synthetic tests do not prove live Gmail,
  deployed n8n, notification delivery, or downstream integration behavior.

## References

- [Architecture and data flows](../architecture.md)
- [Gmail message normalization](../gmail-normalization.md)
- [Deterministic email classification](../email-classification.md)
- [Notification action policy and future Robecruit preferences](../notification-policy.md)
- [Synthetic n8n pipeline](../synthetic-pipeline.md)
- [Controlled live Gmail processing](../live-gmail-processing.md)
- [Application persistence adapter](../../lib/persistence.cjs)
- [Historical ingestion and persistence](../../lib/historical-ingestion.cjs)

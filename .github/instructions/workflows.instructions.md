---
applyTo: "workflows/**/*.json"
---

# n8n workflow definitions

Treat files under `workflows/` as sanitized, version-controlled definitions,
not imported n8n runtime state. Editing an export does not update a local
workflow or its credentials, activation, drafts, or execution data. See
[ADR-0001](../../docs/adr/0001-n8n-workflow-orchestration.md) and
[architecture](../../docs/architecture.md).

Use the repository's offline validation and synthetic tests as documented in
[local setup](../../docs/setup.md). These checks do not prove behavior in a
live n8n runtime or with Gmail; follow the
[workflow verification skill](../skills/verify-workflow/SKILL.md) when
runtime behavior must be verified.

An approved edit to a workflow definition does not authorize importing,
executing, activating or publishing it, or binding credentials. Perform those
runtime operations only when the task explicitly authorizes them. Follow the
[safety model](../../docs/safety-rules.md) for authorization and operational
constraints.

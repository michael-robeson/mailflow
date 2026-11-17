# ADR-0001

## Title

n8n workflow orchestration

## Status

Accepted (retrospective)

## Context

Mailflow uses n8n to orchestrate local workflows and Docker Compose to run
the local services. Reusable processing is also implemented in standalone
JavaScript modules under `lib/`: Gmail normalization, classification,
notification-policy evaluation, and persistence. Workflows can compose these
modules without making notification delivery or Gmail modification part of
the policy decision.

The repository contains sanitized n8n JSON definitions under `workflows/`.
Those files are versioned in Git, but importing, credential binding,
activation, drafts, and execution data belong to the local n8n runtime.
Changing an export does not update an already imported workflow.

## Decision

- Use n8n as the workflow orchestration engine for the current local system.
- Keep reusable processing and persistence logic in `lib/`; use workflows
  to orchestrate it rather than duplicating that logic in workflow nodes.
- Store reviewed workflow definitions in Git under `workflows/` as sanitized
  JSON. Repository exports must remain inactive, omit credential bindings,
  and contain no credentials, pinned data, or real execution data.
- Treat the checked-in definition and imported runtime workflow as separate
  artifacts. Import, credential configuration, and any execution or activation
  are explicit runtime operations, not automatic effects of a Git change.

The repository documents visual workflows and existing integrations as
benefits of n8n, with workflow versioning, credential handling, and execution
data controls as tradeoffs. It does not establish a more specific historical
selection rationale.

## Alternatives considered

The architecture documentation contrasts n8n with custom orchestration and
notes the tradeoffs. The repository does not show that alternatives were
formally evaluated, nor does it record other considered options; this section
does not imply such a review occurred.

## Consequences

- Workflow changes are reviewable and versioned, but Git does not capture
  local credentials, runtime state, or imported-workflow changes. Review and
  explicitly manage those separately.
- Offline synthetic tests and static workflow validation can verify defined
  structure and behavior without live Gmail. They do not prove actual n8n
  runtime behavior; use mock-based n8n verification where needed and document
  substitutions and unverified behavior.
- Reproducing a runtime also requires matching the relevant n8n setup,
  separately configuring credentials, and staging any required local package.
  The checked-in export alone is not a complete deployment or runtime
  snapshot.
- Sanitized, inactive, unbound exports reduce the risk of committing secrets,
  real data, or an executable workflow. Static checks are not a complete
  guarantee that a workflow is safe.

## References

- [Architecture and data flows](../architecture.md)
- [Workflow import, execution, and versioning](../setup.md#workflow-import-execution-and-versioning)
- [Safety model](../safety-rules.md)
- [Synthetic n8n pipeline](../synthetic-pipeline.md)
- [Workflow verification skill](../../.github/skills/verify-workflow/SKILL.md)
- [Workflow export validator](../../scripts/validate.cjs)
- [Reusable pipeline modules](../../lib/)

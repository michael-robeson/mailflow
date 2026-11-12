# Safety model

The current local foundation and in-progress Phase 1B test do not implement
approval, protected-sender rules, cleanup, audit, or rollback systems. The
requirements below are design constraints for future work, not claims that
those protections already exist. See [architecture](architecture.md) and
[Gmail setup](gmail-read-only.md).

## Automation levels

| Level | Scope | Status and required authorization |
| --- | --- | --- |
| 0 — Read-only | Inventory, analysis, reporting. | The proposed manual connectivity test uses GET operations and a read-only OAuth credential; its live execution remains unverified. Larger inventory and reporting are planned. |
| 1 — Non-destructive organization | Labels and archiving; archiving hides messages from the inbox and may still be disruptive. | Planned only. Requires suitable write permissions and explicit, informed approval before changes. |
| 2 — High-impact actions | Trash, unsubscribe, or bulk changes. | Planned only. Requires explicit approval of the concrete plan, additional safeguards, bounded batches, and appropriate permissions. Unsubscribe actions may involve third-party systems. |
| 3 — Irreversible actions | Permanent deletion. | Disabled by project policy, outside initial scope, and not implemented. It must not be inferred from approval of other actions. |

The Gmail `gmail.readonly` scope permits reading message content and settings;
the sample requests only selected metadata. It cannot authorize message
modification. Any permission escalation needs a separate user decision and a
new consent flow with the least privilege required; never silently expand
scopes or use the broad default Gmail credential.

## Requirements before enabling changes

- **Human approval:** present the operation, targets, scope, count, risks, and
  recovery limitations. Approve a specific plan before execution; do not
  treat an old approval as consent for changed targets or future runs.
- **Protected senders and categories:** support explicit protected lists and
  conservative defaults. Exclude protected items before presenting and again
  before acting; require a deliberate review process for exceptions.
- **Dry run:** preview selected messages and proposed actions without changing
  mail or contacting unsubscribe endpoints. Display why each item was chosen.
- **Batch limits:** define a small, configurable maximum before implementation,
  require approval for the plan, and stop at batch boundaries. No numeric
  production limit has been selected or enforced yet.
- **Audit:** record the approved plan, actor, timestamps, attempted actions,
  outcomes, and relevant recovery information with minimal sensitive data.
  Protect and retain audit records according to an explicit policy.
- **Rollback:** favor reversible operations and record prior state where
  practical. Verify recovery with tests; external unsubscribe operations and
  other actions may not be reversible. Permanently deleted messages cannot
  be restored by a Mailflow rollback.
- **Idempotency:** use stable message identifiers and operation records to
  avoid duplicate actions on retries. Re-check current state and approval
  before resuming; handle partial success explicitly.
- **Errors and stopping:** stop on unexpected permissions, scope changes,
  conflicts, or repeated failures; report the affected batch and avoid silent
  success. A future cleanup must provide a visible stop or pause control and
  prevent further batches after cancellation. In-flight external requests may
  already have completed; reconcile outcomes before resuming. No such control
  exists today.

## Operational privacy

Keep credentials, tokens, message contents, personal information, and local
runtime data out of Git and logs. Review exports, pinned data, execution
history, and staged files; ignore rules alone do not guarantee safety. The
sample disables execution saving, but metadata may still be visible in the
editor or transient copies. Preserve the n8n encryption key and securely back
up service data; a backup and restore procedure is not yet implemented. Do
not expose the localhost development instance or its webhooks publicly.

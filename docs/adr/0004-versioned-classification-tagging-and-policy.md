# ADR-0004

## Title

Versioned classification, tagging, policy, and evaluation history

## Status

Accepted

## Context

Mailflow already normalizes Gmail messages, classifies them into deterministic
categories, evaluates a separate notification action policy, and persists
classification and policy history. The current contracts are versioned, but
classification rules and policy defaults are embedded in code. Policy accepts
validated call-site category overrides. The checked-in files under `config/`
are empty placeholders and are not loaded.

There is no tag model, user configuration store, configuration provenance on
decisions, current-decision pointer, or user-correction history. The existing
policy action combines notification eligibility and timing. Existing n8n
workflows and stored rows use version 1.0 contracts and must remain usable
without a coordinated rewrite or automatic reprocessing.

## Decision

### Responsibilities

- **Classification** identifies what a message represents. It produces a
  category and classification evidence; it does not calculate priority or
  notification timing.
- **Tagging** assigns descriptive attributes, including account-owned tags.
  Tags do not change a classification. Policy may read effective
  classification, descriptive tags, and user configuration; tagging never
  invokes policy or notification actions.
- **Policy** evaluates effective classification, descriptive tags, and
  effective user configuration to produce priority, notification eligibility
  and cadence, and a recommended workflow action. Its initial implementation
  selects policy by category only. A recommendation is not a notification,
  schedule, or authorization to act.
- **Persistence** records immutable evaluation history, configuration
  provenance, tag assignments, and explicit user corrections. A separate
  current-effective projection identifies the evaluation and corrections
  currently shown for a message.

Keep these responsibilities in small standalone modules and explicit
contracts. Do not introduce a general rules engine. Custom declarative
classification rules, a visual rules builder, AI assistance, and bulk
reclassification are deferred.

### Versioned contracts

Existing classification schema 1.0 and policy schema 1.0 remain unchanged.
The M1 contracts below are additive; their exact schema versions and field
names are subject to review before implementation.

#### Tag definitions and assignments

A tag definition has a stable `tagId`, display `name`, schema version, and
owner. Owners are either Mailflow (`system`) or an account identified by the
existing opaque `accountKey`; an email address is never an owner identifier.
The definition provenance is `built_in` or `user_defined`. Account-defined
tags belong to that account and do not implicitly become global tags.

An evaluation's tag assignment is descriptive and carries provenance:

```json
{
  "schemaVersion": "1.0",
  "tagId": "newsletter",
  "provenance": {
    "type": "built_in_rule",
    "ruleId": "newsletter_signal"
  }
}
```

The provenance type is `built_in_rule` for a deterministic built-in assignment
or `user_correction` for a manually added assignment; the corresponding rule
or correction identifier is required. Assignments reference definitions and
are stored with the evaluation that produced them. Tags remain descriptive;
their presence never starts policy evaluation or notification actions.

#### Policy decision

The policy input includes effective classification, the effective tag set,
and effective configuration. The initial evaluator uses category-based
defaults and overrides; it accepts effective tags in its context but does not
use them to select a policy result.

The additive policy contract separates notification eligibility and cadence
from the recommended workflow action. It retains the existing `category` and
legacy `action` values:

```json
{
  "schemaVersion": "2.0",
  "category": "interview_request",
  "priority": "high",
  "notificationEligible": true,
  "notificationCadence": "immediate",
  "recommendedAction": "respond",
  "action": "immediate",
  "explanationCodes": ["default_action_selected"],
  "status": "decided"
}
```

Proposed values are `high`, `normal`, `low`, and `unset` for priority;
`immediate`, `daily`, `weekly`, or `none` for v2 policy output
`notificationCadence`; and
`review`, `respond`, `reference`, or `none` for `recommendedAction`. Priority
is `unset` only for insufficient evidence and invalid or unsupported inputs;
a valid, matched classification uses `high`, `normal`, or `low`. The exact
category defaults are:

Effective configuration snapshots continue to represent an ineligible cadence
as `null`; v2 policy output maps that value to `none`.

| Existing classification category | Priority | Notification eligible | Notification cadence | Recommended workflow action |
| --- | --- | --- | --- | --- |
| `application_rejection` | `normal` | `true` | `daily` | `review` |
| `interview_request` | `high` | `true` | `immediate` | `respond` |
| `screening_request` | `high` | `true` | `immediate` | `respond` |
| `application_confirmation` | `low` | `true` | `daily` | `reference` |
| `application_update` | `normal` | `true` | `daily` | `review` |
| `job_alert` | `low` | `true` | `weekly` | `reference` |
| `recruiter_contact` | `normal` | `true` | `immediate` | `respond` |
| `other` / insufficient evidence | `unset` | `false` | `none` | `none` |

These are separate policy dimensions: priority is not calculated from
notification cadence. The cadence and legacy action values preserve the
existing version 1.0 policy defaults. For invalid, unsupported, or
insufficient evidence, fail closed with priority `unset`, no notification,
cadence `none`, legacy action `none`, and recommended action `none`.

The existing version 1.0 `action` field remains a compatibility projection:
it is `immediate`, `daily`, or `weekly` when notification is eligible and
`none` otherwise. Legacy category overrides retain their current meanings.
Eligibility and cadence must be consistent: an ineligible v2 decision has
cadence `none` and legacy action `none`; an eligible decision has one
supported cadence and the matching legacy action. In effective configuration,
an ineligible cadence is represented as `null`. `recommendedAction` is
independent of notification cadence: for example, a message may recommend
`respond` without being notification-eligible. Existing invalid-input and
insufficient-evidence fail-closed behavior remains and sets priority to
`unset`. A user may override supported category policy dimensions subject to
validation. The existing `{ overrides: { category: action } }` configuration
shape remains accepted with its current behavior. These are recommendations
only; no notification or workflow action is executed.

#### Effective configuration

Built-in defaults are versioned with the application release. User overrides
are account-scoped, validated, and stored as immutable revisions. The
database generates a revision ID and creation time; a monotonically increasing
account-scoped version identifies the revision. Each revision retains the
complete canonical account configuration snapshot once and has a deterministic
SHA-256 digest:

```json
{
  "schemaVersion": "1.0",
  "revisionId": 42,
  "version": 3,
  "accountKey": "opaque_account_key",
  "createdAt": "2026-11-17T17:00:00.000Z",
  "snapshot": {
    "policyOverrides": {
      "interview_request": {
        "priority": "high",
        "notificationEligible": true,
        "notificationCadence": "immediate",
        "recommendedAction": "respond"
      }
    },
    "tagDefinitions": []
  },
  "digest": "sha256:<64 lowercase hexadecimal characters>"
}
```

Canonical digests are computed from the complete snapshot with object keys in
sorted order and tag definitions in stable owner/`tagId` order. An evaluation
references `revisionId`, account-scoped `version`, the revision digest, and the
built-in defaults version it used. With no user revision, those user-revision
fields are null. Changing configuration creates a new revision and retains
its full snapshot; it does not itself evaluate messages.

M1 user configuration supports category-based policy overrides, including
priority, notification eligibility, notification cadence, and recommended
workflow action, plus account-owned tag definitions. It does not let users
inject executable code or arbitrary classification patterns. Per-message
corrections are explicit records, not configuration rules. The representation
can later accommodate reviewed declarative rules without implementing a
generalized rule language now.

#### Evaluation history and corrections

Each successful per-message evaluation is immutable and associates the
existing classification and policy results with tag assignments, evaluation
time, and effective configuration provenance. The existing classification
row identifier can serve as the evaluation reference because the schema
already allows one classification per message per workflow run. Persist no
message body, subject, sender, raw headers, or executable rule text.

The versioned evaluation envelope is:

```json
{
  "schemaVersion": "1.0",
  "evaluationId": "evaluation_123",
  "accountKey": "opaque_account_key",
  "messageId": "opaque_message_id",
  "evaluatedAt": "2026-11-17T17:00:00.000Z",
  "classification": {
    "schemaVersion": "1.0",
    "category": "interview_request",
    "status": "matched",
    "matchedRuleIds": ["interview_invitation"],
    "explanationCodes": ["positive_rule_matched"]
  },
  "tagging": {
    "schemaVersion": "1.0",
    "assignments": []
  },
  "policy": {
    "schemaVersion": "2.0",
    "category": "interview_request",
    "priority": "high",
    "notificationEligible": true,
    "notificationCadence": "immediate",
    "recommendedAction": "respond",
    "action": "immediate",
    "explanationCodes": ["default_action_selected"],
    "status": "decided"
  },
  "configuration": {
    "builtInDefaultsVersion": "mailflow-m1.1",
    "accountRevisionId": 42,
    "accountRevisionVersion": 3,
    "accountRevisionDigest": "sha256:..."
  }
}
```

In persistence, `evaluationId` may be the existing classification row ID;
the sample identifier is illustrative. A user tag correction is a separate,
append-only versioned event:

```json
{
  "schemaVersion": "1.0",
  "correctionId": "correction_456",
  "accountKey": "opaque_account_key",
  "messageId": "opaque_message_id",
  "baseEvaluationId": "evaluation_123",
  "target": {
    "type": "tag",
    "operation": "add",
    "tagId": "follow_up"
  },
  "source": "user",
  "createdAt": "2026-11-17T17:05:00.000Z"
}
```

The correction target is a typed, extensible discriminator. M1 implements only
tag corrections (`add` or `remove`); future classification and policy
corrections may add target-specific payloads without changing the event
envelope. Future correction types are not executed or persisted by the
initial implementation.

User tag corrections are append-only events tied to an account, message, and
base evaluation. The minimal event records a correction ID, `tagId`,
`add` or `remove`, actor type `user`, and creation time. A correction does not
overwrite the evaluation or earlier corrections. The effective tag set is
the evaluation's assignments with applicable corrections applied in order;
later corrections can reverse earlier ones.

The current-effective decision is a projection for each account/message:
the explicitly selected evaluation plus its applicable user tag corrections.
It is not a replacement for history. Advance the current-evaluation pointer
only as part of an explicitly committed evaluation; historical replay does
not silently make old or backfilled results current. Corrections update the
tag projection only. For legacy records without a pointer, expose a read-only
current-state fallback only when there is no explicit current-effective
record and exactly one complete, valid classification/policy pair exists for
the account and message. Validate the pair against the legacy contract; if
there are zero or multiple candidates, or any ambiguity, report unresolved
rather than choosing one. Legacy configuration provenance remains unknown
and is never inferred.

### Explicit, bounded reevaluation

Creating or changing a user configuration and adding or removing a tag never
starts reclassification, policy evaluation, or notification delivery.
Reevaluation requires an explicit request naming the target messages and the
configuration version to use. The initial request limit is 25 messages. A
future implementation may configure a lower limit through a validated
integer setting from 1 through 25; it may not exceed the initial cap. A
policy-only reevaluation uses the stored effective classification and tags.
Classification reevaluation requires an explicitly authorized source of
message data; current persistence does not retain message content.

Reevaluation appends a new evaluation and advances the current pointer only
when explicitly requested. There are no notification or Gmail actions in
this design. Retrying an identical persistence request must continue to use
the existing run-ID and input-hash safeguards. No reevaluation sends
notifications or mutates Gmail.

### Compatibility and transition

- Keep `classifyEmail`, `evaluateNotificationPolicy`, current pipeline reports,
  and all existing workflow exports on their current contracts until a later
  implementation is separately reviewed.
- Introduce the new policy contract through an additive adapter or entry
  point. Existing v1 callers continue to receive their existing result shape;
  new callers may consume v2 dimensions, including the separate
  notification-cadence and recommended-action fields.
- Preserve existing database rows and migrations. Treat their configuration
  provenance as legacy/unknown; do not infer versions or rewrite decisions.
- Future writes append versioned evaluation data and provenance. Readers
  support both legacy rows and new rows; use the read-only current-state
  fallback only for an unambiguous legacy record. No automatic migration
  replays Gmail, reclassifies history, or sends notifications.
- Update n8n workflow exports only after the standalone contracts and
  persistence mapping have been reviewed and tested. Existing imported
  workflows remain separate runtime artifacts.

## Alternatives considered

- Combining tags with classification categories would conflate mutually
  independent responsibilities and constrain user-defined descriptive tags.
- Putting notification cadence into classification would make classification
  depend on user preference and would preserve the current policy coupling.
- Updating an evaluation row in place would erase the distinction between
  machine output, user correction, and historical decisions.
- Automatically reevaluating history on configuration changes would create
  unbounded work and unexpected decision changes; it is rejected.
- A generalized rules engine, visual builder, AI classifier, and bulk
  reclassification add scope without being required for the initial
  versioned contracts.

## Consequences

- The existing classification and policy behavior remains available while
  consumers transition to explicit tags and policy dimensions.
- Configuration versions, provenance, immutable evaluations, corrections,
  and a current-effective projection require persistence changes in a new
  migration. Existing migrations remain immutable.
- The legacy `action` field continues to encode notification eligibility and
  cadence for compatibility. The new recommended workflow action is a
  separate dimension and may remain `review`, `respond`, or `reference` when
  notification is ineligible.
- Policy-only reevaluation can use stored classification history. True
  classification reevaluation cannot be reconstructed from current stored
  records because message content is intentionally not persisted.
- Current/effective selection and correction overlays need focused offline
  tests before any workflow is changed. The 140-test baseline must continue
  passing.

## References

- [Architecture and data flows](../architecture.md)
- [ADR-0003 — Processing, classification, and policy boundaries](0003-processing-and-policy-boundaries.md)
- [Gmail message normalization](../gmail-normalization.md)
- [Deterministic email classification](../email-classification.md)
- [Notification action policy](../notification-policy.md)
- [Extensibility and deferred capabilities](../extensibility.md)
- [Application persistence](../postgres-persistence.md)
- [Synthetic pipeline](../synthetic-pipeline.md)

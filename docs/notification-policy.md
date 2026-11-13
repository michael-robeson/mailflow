# Notification action policy

`lib/notification-policy.cjs` maps a Phase 1E-B classification result to a
recommended action without sending or scheduling a notification:

```js
const { evaluateNotificationPolicy } = require('./lib/notification-policy.cjs');
const decision = evaluateNotificationPolicy(classification);
```

The versioned decision contains only `schemaVersion`, `category`, `action`,
`explanationCodes`, and `status`. The action is one of `immediate`, `daily`,
`weekly`, or `none`. The policy reads only the classification schema version,
category, and status; it does not return message IDs, rule IDs, sender details,
subjects, bodies, or other input fields.

## Default actions

| Classification category | Default action |
| --- | --- |
| `application_rejection` | `daily` |
| `interview_request` | `immediate` |
| `screening_request` | `immediate` |
| `application_confirmation` | `daily` |
| `application_update` | `daily` |
| `job_alert` | `weekly` |
| `recruiter_contact` | `immediate` |
| `other` / insufficient evidence | `none` |

These are conservative review-timing recommendations, not delivery behavior.
In particular, an immediate decision does not send an alert, and daily/weekly
decisions do not create digests or schedules.

## Overrides and safe defaults

Callers may provide a strict per-category override configuration:

```js
evaluateNotificationPolicy(classification, {
  overrides: {
    application_update: 'weekly',
    job_alert: 'none',
  },
});
```

Each override must use a supported category and one of the four supported
actions. Invalid configuration fails closed with action `none` and status
`invalid_configuration`. Malformed or unsupported classification results also
select `none`. An `insufficient_evidence` result is always `none`, even if an
`other` override is supplied. Configuration is evaluated independently from
delivery, storage, and workflow execution.

## Future Robecruit preferences

Robecruit may later build user-specific preferences by supplying validated
category overrides at the call site. The current module has no user profile,
database, persistence, delivery adapter, or implicit preference source.
Future preference resolution should remain explicit, validate values against
the same action/category contract, preserve the fail-closed behavior, and keep
user configuration separate from notification transport. No message content
should be stored in or copied to a policy decision.

Run its synthetic tests with:

```sh
node --test tests/notification-policy.test.cjs
```

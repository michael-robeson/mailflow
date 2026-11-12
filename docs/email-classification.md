# Deterministic email classification

`lib/email-classify.cjs` accepts a normalized Gmail message with
`schemaVersion: "1.0"` and returns a standalone classification:

```js
const { classifyEmail } = require('./lib/email-classify.cjs');
const result = classifyEmail(normalizedMessage);
```

The result contains `schemaVersion: "1.0"`, `messageId` (the unchanged
normalized ID or `null`), `category`, `matchedRuleIds`, `explanationCodes`,
and `status`. A supported message with positive evidence has `status: "matched"`;
otherwise it has category `other` and `status: "insufficient_evidence"`.
Invalid inputs have `status: "invalid_input"`; other or missing schema versions
have `status: "unsupported_schema"`. Missing IDs are reported via
`missing_message_id` and must not be used for deduplication.

Rules use subject, body, and a limited sender-role signal. Each matching rule
contributes its stable identifier, ordered by this precedence:

1. `rejection_application_outcome` — `application_rejection`
2. `interview_invitation` — `interview_request`
3. `screening_invitation` — `screening_request`
4. `application_received` — `application_confirmation`
5. `application_status_update` — `application_update`
6. `job_alert_digest` — `job_alert`
7. `recruiter_direct_outreach` — `recruiter_contact`

When multiple rules match, the first determines the category and
`precedence_applied` explains why. Rejection precedes earlier-stage invitations,
which may occur in quoted email history; interview and screening outrank generic
recruiter outreach. No confidence score is inferred. A recruiter sender alone,
generic interview tips, or a job-market mention is insufficient evidence.
Positive non-rejection patterns in a sentence containing common negation or
cancellation words are suppressed; this is conservative and may miss a real
request when unrelated negation occurs in the same sentence.

These are conservative phrase-based heuristics, not a guarantee of intent.
They do not reliably understand quotations, negation, sarcasm, multilingual
text, company-specific wording, or conflicting messages. An old quoted
invitation may match, and unfamiliar wording can yield `other`. Treat results as
review aids. The code does not perform notification prioritization, delivery,
Gmail access, or message modification.

No sender, subject, body, matching text, or derived snippets are returned or
logged; the message ID itself remains sensitive. Do not log or publish
classification results containing real identifiers. Subject and body remain
untrusted text and must be escaped for any rendered output.

Run synthetic tests with:

```sh
node --test tests/email-classify.test.cjs
```

---
name: verify-workflow
description: "Verify a Mailflow workflow change using offline tests"
---

# Verify a Mailflow workflow change

Verify the workflow or change described in the invocation against its
acceptance checks. If the scope or checks are missing, ask for them before
starting.

1. Inspect the current branch, worktree, relevant workflow exports, and
   existing offline test tooling. Reuse repository tooling where practical.
2. Choose tests that exercise the requested behavior, not just a proxy. Use
   synthetic fixtures and isolated services. Disposable credentials for
   isolated test services are allowed; live Gmail, production credentials,
   and production data are out of scope. Do not activate checked-in workflows.
3. When acceptance checks require actual n8n behavior, run the workflow in
   n8n with temporary mock nodes or endpoints where feasible. Preserve the
   behavior under test and document every substitution. Clearly distinguish
   actual n8n execution from JavaScript simulation.
4. Verify each acceptance check with observable evidence. If a required setup
   is unavailable or a check fails, report the specific blocker or failure
   and what remains unverified. For routine, low-risk failures introduced by
   the approved change, correct them within scope and rerun affected checks.
   Escalate substantive architectural questions, scope changes, security
   concerns, destructive operations, and unresolved failures. Do not present
   partial coverage as a pass.
5. Keep changes scoped to verification. Preserve pre-existing worktree
   changes, do not commit or push, and obtain approval before destructive
   cleanup. If any files change, provide a complete review patch that includes
   new files and excludes unrelated pre-existing changes.

Return one report containing:

- Scope and acceptance checks.
- Commands run and relevant tool/runtime versions.
- Observed evidence and pass/fail/unverified status for each check.
- Test substitutions, limitations, and anything not verified.
- Files changed and a link to the complete review patch, if applicable.

## Example invocation

`/verify-workflow` Scope: 09 historical ingestion parent and one-page child.
Checks: with three mock Gmail pages and isolated PostgreSQL, verify in actual
n8n that the parent calls the child three times in order, pairs each reply
with its request state, checkpoints each page before the next request, and
stops after page three with `exhausted`. Set the message limit above the
fixture total and verify there is no fourth request.

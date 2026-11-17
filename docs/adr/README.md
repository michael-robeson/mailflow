# Architecture decision records

Architecture decision records (ADRs) capture durable architectural choices
and their rationale so future changes can refer to them without duplicating
the full design documentation.

## Convention

- Name records with a zero-padded sequence and a short kebab-case title:
  `NNNN-short-title.md`.
- Use the sections **Title**, **Status**, **Context**, **Decision**,
  **Alternatives considered**, **Consequences**, and **References**.
- Use `Accepted (retrospective)` when recording an existing decision
  reconstructed from current code or documentation. Do not invent a decision
  date or imply alternatives were formally evaluated without evidence.
- Keep records concise. Link to canonical architecture, safety, and
  implementation documents rather than copying their detailed procedures.
- Record a new decision in a new ADR; mark a superseded record and link its
  replacement rather than rewriting the historical decision.

## Records

- [0001 — n8n workflow orchestration](0001-n8n-workflow-orchestration.md)
- [0002 — Application database isolation](0002-application-database-isolation.md)
- [0003 — Processing, classification, and policy boundaries](0003-processing-and-policy-boundaries.md)

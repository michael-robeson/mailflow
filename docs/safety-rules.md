# Safety rules

1. Phase 1A does not connect to Gmail, access email accounts, or process mail.
2. Never delete, archive, move, unsubscribe, or modify Gmail messages without
   an explicitly approved workflow and appropriate safeguards.
3. Future high-impact operations require explicit human approval, small
   auditable batches, and a documented recovery strategy where possible.
4. Keep credentials, tokens, message contents, personal information, and
   local runtime data out of Git and logs.
5. Preserve the n8n encryption key and back up persistent data securely.
6. Do not expose this development instance or its webhooks publicly.

These are design requirements, not implemented Gmail safeguards. Future
phases must implement and test the controls before carrying out any action.

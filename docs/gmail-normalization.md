# Gmail message normalization

`lib/gmail-normalize.cjs` converts a Gmail API **full-format** message object
into an offline JSON-compatible representation. It makes no requests, changes
no mail, does not log, and is not wired into an n8n workflow.

```js
const { normalizeGmailMessage } = require('./lib/gmail-normalize.cjs');
const normalized = normalizeGmailMessage(gmailMessage);
```

The result has a stable shape:

```text
{
  schemaVersion: "1.0",
  id: string | null,
  threadId: string | null,
  sender: { name: string | null, address: string | null },
  subject: string | null,
  receivedAt: string | null,
  body: string,
  warnings: string[]
}
```

`schemaVersion` identifies the output contract and is present for every result,
including invalid inputs. `id` and `threadId` preserve the source strings; a missing ID is reported in
`warnings` and must not be used as a deduplication key. The sender parser
accepts ordinary bare and display-name addresses and lowercases the address;
it is not a complete RFC email-address or encoded-header parser. Duplicate
From or Subject headers are not guessed. `receivedAt` is UTC ISO 8601,
preferring Gmail's millisecond `internalDate`, then an explicitly zoned
`Date` header. Missing fields are null; unavailable text is an empty string.

The MIME traversal prefers `text/plain` within `multipart/alternative`, joins
text sections of other multipart containers in order, and ignores attached
messages, named parts, and attachment-disposition parts. Inline `body.data` is decoded as base64url,
using the declared charset or UTF-8. An external `attachmentId` is not fetched;
unsupported or malformed data produces warning codes rather than message
content in diagnostics. Metadata-only Gmail responses normally have no body.

HTML is converted to readable text without a browser or code execution;
scripts, styles, and tags are removed and common entities decoded. This is a
best-effort text conversion, **not an HTML sanitizer**: treat the resulting
body as untrusted text and escape it for the output context before inserting
it into HTML. Decoded entities can themselves form HTML markup. It does not interpret
CSS, fetch resources, decode every HTML entity, or guarantee layout fidelity.

Normalization exposes sensitive message content to the caller. Do not log,
pin, commit, or share results containing real messages. A future n8n Code node
must embed or otherwise make this CommonJS logic available in its actual
runtime; module availability, Buffer, and TextDecoder must be verified there.
No n8n integration or Gmail body-access authorization is implied by this module.

Run synthetic tests with:

```sh
node --test tests/gmail-normalize.test.cjs
```

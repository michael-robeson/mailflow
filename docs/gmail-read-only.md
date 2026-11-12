# Gmail read-only connectivity

Historical notes report a local manual read-only test returning metadata for
five messages on November 12, 2026. Automatic OAuth token refresh and
post-change execution retention remain unverified. The definition is not
automatically imported into n8n.

This manual test is designed to list the first page of Gmail messages,
requesting at most five IDs, and get only the `From`, `Subject`, and `Date`
headers and label IDs for those messages. Gmail normally returns recent
messages first, but the list API does not document a sorting guarantee. An
empty mailbox produces no message output. No message bodies or attachments
are requested.

The OAuth scope `https://www.googleapis.com/auth/gmail.readonly` allows
reading more than this workflow requests, including message contents and
settings. Treat the credential as sensitive. The workflow never uses a write
operation, sends mail, or changes messages.

## Google Cloud and n8n OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/), create or
   select a project dedicated to Mailflow. Under **APIs & Services > Library**,
   enable **Gmail API**.
2. Configure **Google Auth Platform** / the OAuth consent screen. Set an app
   name and support and contact email. For a personal Gmail account, choose
   **External**, keep the app in **Testing**, and add your account under
   **Audience > Test users**. Under **Data Access**, add only
   `https://www.googleapis.com/auth/gmail.readonly` as the Gmail scope.
   Google classifies this scope as restricted. Testing-mode authorization may
   expire and require reauthorization.
3. In n8n, create an **OAuth2 API** credential and copy its displayed
   **OAuth Redirect URL**. Under **APIs & Services > Credentials** in Google
   Cloud, create an **OAuth client ID** of type **Web application**, using that
   exact URL as an authorized redirect URI. For the local Compose setup it is
   normally `http://localhost:5678/rest/oauth2-credential/callback`; verify
   the value displayed by your own n8n instance.
4. Enter the client ID and secret directly in the n8n credential. Set:
   - **Grant Type:** Authorization Code
   - **Authorization URL:** `https://accounts.google.com/o/oauth2/v2/auth`
   - **Access Token URL:** `https://oauth2.googleapis.com/token`
   - **Scope:** `https://www.googleapis.com/auth/gmail.readonly`
   - **Auth URI Query Parameters:** `access_type=offline&prompt=consent`
   - **Authentication:** Body

   Leave SSL verification enabled. Save and connect the credential. Check
   Google's consent screen and cancel if it requests broader Gmail access.
   Do not share or commit your client secret, authorization code, or tokens.

The built-in Gmail credential in n8n 2.47.4 defaults to broader scopes,
including full mail access. It offers custom scopes, but this workflow uses
the generic OAuth2 credential explicitly to avoid those defaults. See the
[n8n OAuth documentation](https://docs.n8n.io/integrations/builtin/credentials/google/oauth-generic/)
and [Google's Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Import and run

The following is historical setup guidance, not authorization to import or
run a workflow. Obtain explicit approval before either action.

1. Import [the sanitized workflow](../workflows/01-gmail-connectivity.json)
   through n8n's workflow menu. It contains no credential binding; select your
   read-only **OAuth2 API** credential in both **List Messages** and
   **Get Message Metadata**.
2. Confirm workflow settings disable saving manual execution data, production
   execution data, and execution progress. Leave the workflow inactive. Do
   not pin node output.
3. Select **Execute workflow**. Inspect the **Show Metadata** node's output
   locally: it should contain zero to five items with `id`, `sender`, `subject`,
   `date`, and `labels`. An empty result can mean there are no messages in
   the first page. Fix reported OAuth or API errors rather than granting
   broader permissions.
4. Do not copy real output into Git, issue reports, chat, logs, or exported
   workflow data. Node output is sensitive metadata and can still be visible
   in the editor during execution. Disabling execution saves limits persistence
   but is not a guarantee that every intermediate copy is erased. Review any
   workflow export for credential references and pinned or execution data
   before committing it.

The workflow file is a sanitized, unbound definition. Keep local
credential bindings and real execution data out of the repository.

## Execution retention review

Historical notes from November 12, 2026 report that the imported connectivity
workflow initially lacked explicit save settings and retained five manual
execution records: three successful and two failed. Three data rows contained
metadata-related field names; contents were not displayed. The historical
notes reported no instance `EXECUTIONS_*` overrides and defaults of saving
manual, successful, and failed executions, with progress saving off. After
settings were adjusted, a read-only check reported manual, successful, and failed
execution saving disabled; progress saving inherited an off instance default.
No live execution verified the revised retention behavior. These observations
are historical, not a guarantee of current configuration or record counts.

Check effective workflow and instance settings after import or configuration
changes. Disabling saving does not erase historical records, editor output,
logs, pinned data, or backups. Inspect sensitive records locally without
exporting them. Delete records through supported n8n controls only after
explicit approval; do not modify PostgreSQL directly. Instance-wide execution
settings or service restarts also require separate approval.

The historical review also noted that `gmail.metadata` may be sufficient for
some metadata-only uses, but Gmail's `messages.list` does not permit the `q`
parameter with that scope. Any scope change requires a separate decision and
consent. OAuth publication, restricted-scope verification, privacy disclosures,
retention, deletion requests, and backup procedures require separate review.

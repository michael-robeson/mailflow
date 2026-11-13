# Local setup and onboarding

## Prerequisites

| Dependency | Requirement |
| --- | --- |
| Linux, macOS, or Windows | Required, with a working Docker-compatible environment for your platform. Commands below use Fish and Bash; adapt them for other shells. |
| Docker Engine and Docker Compose plugin | Required for the documented setup. A compatible alternative would need separate verification; Podman compatibility has not been verified. |
| Git and access to the private GitHub repository | Required to clone the project. |
| OpenSSL | Required for the secret-generation command below. |
| Google account with Gmail and Google Cloud Console access | Required for the optional Phase 1B Gmail test, not for starting the local services. |
| Gmail API and OAuth 2.0 web client | Required for the Gmail test; set these up in Google Cloud as described in [Gmail setup](gmail-read-only.md). |
| Node.js 22 | Required for local quality checks and the pre-commit hook; no npm packages are needed. |

The local foundation is Phase 1A. Historical notes report a local manual
read-only connectivity test; the supplied definition remains unbound and
automatic token refresh is unverified. Prior execution data may remain; review
[execution retention](gmail-read-only.md#execution-retention-review). Do not
treat authorization on one installation as authorization for another.

## Local validation and Git hooks

Run these commands from the repository root in Fish or Bash. They use only
Node.js and Git; they do not contact Gmail or require n8n:

```sh
node scripts/validate.cjs
node --test tests/*.test.cjs
```

The validator scans tracked and non-ignored untracked files, checks workflow
JSON for syntax and duplicate decoded object keys, and checks workflow safety.
The scanner reports filenames and categories, never matching secret values.
Ignored local files such as `.env` are not scanned unless staged. For the
exact staged snapshot, run `node scripts/validate.cjs --staged` after staging.

Install the versioned hook once per clone:

```sh
sh scripts/install-hooks.sh
```

The installer refuses to overwrite an existing different `core.hooksPath`.
The hook validates staged file contents and runs the synthetic tests against
the working tree. Stage the implementation and tests together, and run tests
on the intended snapshot; unstaged changes can otherwise affect test results.
Git does not install hooks automatically, and `--no-verify` or changes to
`core.hooksPath` can bypass them. Reinstall after a fresh clone and use CI as
the independent gate. Pull requests targeting `develop` run both commands and
an isolated PostgreSQL persistence integration test. CI pulls its test images;
the local offline commands above require neither containers nor a database.
See [persistence testing](postgres-persistence.md#provisioning-and-migration-after-approval)
for the separate optional local database test.

These are conservative static checks, not a proof of safety: HTTP Request
nodes must use literal GET (or the default GET), native Gmail nodes must
specify a permitted read operation, and exports must be inactive and omit
credential fields, credential headers, and pinned data. Direct network and
module-access patterns in Code nodes are also rejected. Code nodes and other
custom nodes can nevertheless execute arbitrary behavior that static checks
cannot reliably analyze. The lightweight secret scanner recognizes common token formats,
credential assignments, and sensitive filenames, but cannot identify every
secret or all execution data. Review workflow exports and diffs manually.

## Install locally

The commands in this section are for **Fish**; step 2 explicitly invokes
Bash. Use a directory where you want the clone.

1. Clone the private repository and verify prerequisites:

   ```fish
   git clone https://github.com/michael-robeson/mailflow.git
   cd mailflow
   docker --version
   docker compose version
   docker info
   git --version
   openssl version
   ```

   GitHub authentication and repository access are required. If the clone
   fails, arrange access rather than placing credentials in the URL.

2. Create `.env` only if it does not already exist. The command creates the
   same variables shown in [`.env.example`](../.env.example), independently
   generates both values, and makes the file private to your OS user:

   ```fish
   bash -c 'set -eu; umask 077; set -o noclobber
   postgres_password=$(openssl rand -hex 32)
   encryption_key=$(openssl rand -hex 32)
   printf "POSTGRES_PASSWORD=%s\nN8N_ENCRYPTION_KEY=%s\nGENERIC_TIMEZONE=UTC\n" "$postgres_password" "$encryption_key" > .env'
   ```

   Bash refuses to overwrite an existing `.env`; preserve existing secrets.
   Optionally set `GENERIC_TIMEZONE` to an IANA timezone such as
   `America/Chicago`. Do not replace the encryption key after n8n stores
   credentials: losing it makes them unreadable. Changing the password in
   `.env` does not update an existing PostgreSQL database; change the database
   password separately before updating the configuration.

3. Validate the configuration without printing resolved secrets, then start:

   ```fish
   docker compose config --quiet
   docker compose up -d
   docker compose ps
   ```

   Wait until both services show `healthy`. To check PostgreSQL readiness
   directly, run:

   ```fish
   docker compose exec postgres pg_isready -U n8n -d n8n
   ```

4. Open [http://localhost:5678](http://localhost:5678) and complete n8n's
   local owner-account setup. Do not expose this development instance via
   a public tunnel, proxy, or webhook.
5. Follow [Gmail setup](gmail-read-only.md) to create the Google project and
   read-only OAuth credential, import the sample, bind the credential, and
   execute the test manually.

To stop or restart without deleting data:

```fish
docker compose stop
docker compose start
```

`docker compose down` removes the containers and network but retains named
volumes by default. Never use `docker compose down --volumes` unless you
explicitly intend to permanently delete the database and n8n data.

## Google Cloud onboarding

The Gmail connection requires API registration, not a Google Cloud hosting
deployment. Create or select a dedicated project, enable Gmail API, configure
the consent screen, and add your account as a test user if using an external
app in Testing. Create a **Web application** OAuth client and register the
exact redirect URI displayed by the local n8n credential. Request only
`https://www.googleapis.com/auth/gmail.readonly` and enter the client
credentials directly into n8n. The [Gmail guide](gmail-read-only.md) provides
the exact fields and connectivity test steps; never paste credentials into
Git, chat, logs, or issue reports.

## Workflow import, execution, and versioning

In the n8n editor, use the workflow menu's **Import from File** option and
select the JSON file. Bind credentials locally after import; the sanitized
sample deliberately has no credential binding. In n8n 2.47.4, editing saves a
draft; publishing makes a version available to production triggers. A manual
test runs the editor's draft via **Execute workflow** and does not require
publishing. Leave the sample inactive; it has no production trigger. UI
wording can vary across n8n versions.

To version a workflow, use the workflow menu's **Download** option, review
the JSON, and retain only a sanitized definition under `workflows/`. Remove
credential names and IDs, tokens, authorization headers, pinned data, real
execution results, and email metadata. Workflow exports can include
credential references and pinned data; they are not automatically safe.
Review the diff, test with synthetic data, and commit and push only after
review and authorization. Git records definitions, not n8n's runtime state.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| OAuth redirect URI mismatch | Copy the URI displayed in the n8n credential exactly into the Google web client's authorized redirect URIs, including scheme, host, port, and path. |
| Consent denied or app unverified | Confirm the selected Google project, audience, Testing status, and test-user account. Google may show an unverified-app warning for restricted scopes. Do not grant unexpected permissions. |
| Credential expired or revoked | Reconnect the local credential after checking the consent screen and scope. Testing-mode refresh tokens can expire; organization policies may also apply. |
| Port 5678 already in use | Identify the conflicting service and resolve it deliberately; if changing the local URL, update and verify the OAuth redirect URI too. Do not stop unrelated containers without permission. |
| PostgreSQL connection or health failure | Check `docker compose ps`, readiness, and sanitized `docker compose logs --tail=100 postgres n8n`. Verify both services, the Compose network, and matching database credentials; do not print `.env`. |
| Missing credentials after import | Create or select the local OAuth2 API credential in both HTTP Request nodes. A sanitized export intentionally omits the binding. |
| Incorrect Gmail scopes | Inspect the credential and Google consent. Cancel broader requests; use only the read-only scope for Phase 1B. Reauthorize with the correct scope if necessary. |

Treat logs and error reports as sensitive: inspect locally and redact any
credentials, email addresses, message IDs, headers, or message content before
sharing.

## Secrets and persistence

`.env` is ignored by Git. Never share it, paste it into logs, or commit it.
Ignore patterns are not exhaustive; inspect staged files before every commit.
Docker administrators can inspect container environment variables, so local
environment variables are not a strong secret vault. Store a secure backup of
the encryption key and PostgreSQL password outside the repository, and back
up the PostgreSQL database and n8n data together. Losing the encryption key
prevents recovery of encrypted credentials. This phase does not implement a
backup or restore procedure; verify backups before relying on them.

The PostgreSQL volume holds n8n's database; the n8n volume holds its local
settings and other n8n files. These volumes are not part of the Git repository.
The images are version-pinned; review security updates and migration notes
before upgrading. PostgreSQL major upgrades require a planned data migration.

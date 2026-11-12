# Local setup

These commands use Fish. Run them from the project directory.

1. Verify prerequisites:

   ```fish
   docker --version
   docker compose version
   docker info
   git --version
   openssl version
   ```

2. Create `.env` only if it does not already exist. The two values are
   independently generated, and the file is private to your OS user:

   ```fish
   bash -c 'set -eu; umask 077; set -o noclobber
   postgres_password=$(openssl rand -hex 32)
   encryption_key=$(openssl rand -hex 32)
   printf "POSTGRES_PASSWORD=%s\nN8N_ENCRYPTION_KEY=%s\nGENERIC_TIMEZONE=UTC\n" "$postgres_password" "$encryption_key" > .env'
   ```

   This invokes Bash from Fish and refuses to overwrite an existing `.env`.
   Preserve existing secrets if the command reports that the file exists.

   `GENERIC_TIMEZONE` can be changed to an IANA timezone such as
   `America/Chicago`. Do not replace the encryption key after n8n has stored
   credentials: losing it makes encrypted credentials unreadable. Changing the
   PostgreSQL password in `.env` does not update an existing database; change
   the database password separately before updating the configuration.

3. Validate and start:

   ```fish
   docker compose config --quiet
   docker compose up -d
   docker compose ps
   ```

   Wait until both services are healthy, then visit
   [http://localhost:5678](http://localhost:5678). Create an n8n owner account
   locally; do not add Gmail or other integrations in Phase 1A.

4. To stop or restart without deleting data:

   ```fish
   docker compose stop
   docker compose start
   ```

   `docker compose down` removes the containers and network but retains named
   volumes by default. Never use `docker compose down --volumes` unless you
   explicitly intend to permanently delete the database and n8n data.

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

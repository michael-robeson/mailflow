# Mailflow

Mailflow is a personal email automation and intelligent inbox management project
built around n8n. Its long-term goal is to inventory and categorize mail,
recommend cleanup, carry out explicitly approved actions in auditable batches,
and eventually provide summaries and learn from feedback.

## Status

Phase 1A provides a local n8n and PostgreSQL environment only. There are no
Gmail credentials, integrations, workflows, message processing, or cleanup
actions. The configuration files are placeholders, not active rules.

## Prerequisites

- Docker with a running daemon and the Docker Compose plugin
- Git
- OpenSSL for local secret generation
- An available localhost port 5678

Follow [local setup](docs/setup.md) to create the untracked `.env`, generate
secrets, and start the services. The setup commands are written for Fish.

```fish
docker compose up -d
docker compose ps
```

Open [http://localhost:5678](http://localhost:5678) and complete n8n's local
owner-account setup. Do not connect Gmail during this phase.

```fish
# Stop containers without removing data.
docker compose stop
# Start stopped containers again.
docker compose start
# Inspect service logs.
docker compose logs --tail=100 n8n postgres
```

PostgreSQL and n8n use separate Docker named volumes. Stopping or restarting
containers preserves them; removing volumes destroys their contents. Back up
both volumes' data and the encryption key securely before upgrades or changes.
See [setup](docs/setup.md) for secrets and persistence details.

See [architecture](docs/architecture.md) and [safety rules](docs/safety-rules.md)
for the design and constraints.

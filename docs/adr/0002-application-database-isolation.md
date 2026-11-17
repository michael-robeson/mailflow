# ADR-0002

## Title

Application database isolation

## Status

Accepted (retrospective)

## Context

The default [Compose configuration](../../compose.yaml) runs PostgreSQL for
n8n's operational data. It uses the `n8n` database and role, a
`postgres_data` volume, and n8n's separate `n8n_data` volume.
The repository does not specify a separately named n8n schema or track its
internal schema migrations; that operational schema lifecycle is managed by
n8n, not by the application's numbered migration files.

Application persistence is defined separately in the opt-in
[database Compose override](../../compose.mailflow-db.yaml): a PostgreSQL
service, `mailflow` database, `mailflow_application_data` volume, and internal
`mailflow_persistence` network with no published database port. Provisioning
uses the `mailflow_admin` bootstrap role plus separate `mailflow_owner`
migration-owner and restricted `mailflow_app` runtime roles. The application
migrations create a `mailflow` schema and its own `schema_migrations` ledger.
Migration 1 defines message and decision history; migration 2 adds historical
ingestion and checkpoint state. The optional
[integration override](../../compose.mailflow-integration.yaml) connects n8n
to the application database network.

The persistence documentation says the separation avoids sharing n8n's
database cluster and backup/restore lifecycle. It does not record a more
specific historical analysis of the alternatives.

## Decision

- Keep n8n operational data and Mailflow application data in separate
  PostgreSQL services, databases, schemas, volumes, roles, and migration
  lifecycles.
- Apply numbered files under `migrations/` to the application database as its
  migration owner. Do not apply them to n8n's database or edit an applied
  migration.
- Use a restricted application runtime role; do not reuse n8n's bootstrap
  role, credentials, or volume for application persistence.
- Treat backup, restore, credential recovery, and migration responsibilities
  as independent for each database.

This describes the current local design. The application service is opt-in;
the default Compose configuration does not start it. This decision does not
select or establish a production or future cloud deployment architecture.

## Alternatives considered

Reusing n8n's database cluster, role, or volume for application data is the
contrasting design documented in the persistence guide and is explicitly
rejected there. The repository does not establish that alternatives such as
separate databases within one cluster or a managed database were formally
evaluated.

## Consequences

- Independent services and volumes reduce coupling between application
  schema changes and n8n operational state and recovery. They also require
  separate provisioning, credentials, migrations, backups, and restore
  procedures.
- The application migration ledger records versions but not checksums.
  Migration provenance and order must be reviewed; applied migrations remain
  immutable.
- In the documented local setup, the database network is internal and has no
  published host port, but the optional integration joins n8n to that network.
  Docker administrators and trusted n8n code remain privileged; the boundary
  is not an absolute security barrier.
- The application runtime role can access all application accounts, and the
  documented database connection is not TLS-encrypted. These are current
  limitations, not guarantees suitable for another deployment.
- The operational documentation calls for independent backups and restores.
  A restore test for the application database is not yet documented as
  complete.

## References

- [PostgreSQL persistence and recovery](../postgres-persistence.md)
- [Architecture and data flows](../architecture.md)
- [Default n8n Compose configuration](../../compose.yaml)
- [Application database Compose override](../../compose.mailflow-db.yaml)
- [Optional n8n integration override](../../compose.mailflow-integration.yaml)
- [Application migration 1](../../migrations/001_persistence_foundation.sql)
- [Application migration 2](../../migrations/002_historical_ingestion.sql)
- [Persistence adapter](../../lib/persistence.cjs)

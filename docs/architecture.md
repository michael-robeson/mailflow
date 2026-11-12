# Architecture

Phase 1A runs two services on a private Compose bridge network:

- n8n provides the local workflow editor and stores its application data in
  PostgreSQL. Its persistent volume holds n8n settings and files.
- PostgreSQL stores n8n's database in a separate persistent volume. It has no
  published host port.

n8n listens on host `127.0.0.1:5678` only. PostgreSQL must become healthy
before n8n starts; n8n's readiness endpoint checks that its database is
connected and migrated. Both services restart unless explicitly stopped.

This is a local development configuration, not a hardened public deployment.
HTTP and non-secure cookies are used for localhost access. The bridge network
still permits outbound connections; localhost binding does not prevent n8n
or a workflow from accessing external services. Do not expose it through a
tunnel, proxy, or public webhook in this phase.

The checked-in configuration files are inert placeholders. No workflows or
application-specific database migrations are installed. Future phases will
define their schemas and behavior when needed.

'use strict';

const fs = require('node:fs');
const { Client } = require('pg');

async function main() {
  const credentials = JSON.parse(fs.readFileSync(0, 'utf8'));
  for (const key of ['admin', 'owner', 'app']) {
    if (typeof credentials[key] !== 'string' || !/^[a-f0-9]{64}$/.test(credentials[key])) {
      throw new Error('Invalid credentials');
    }
  }
  const connect = (user, password) => new Client({
    host: '127.0.0.1', port: 5432, database: 'mailflow', user, password,
  });
  const admin = connect('mailflow_admin', credentials.admin);
  await admin.connect();
  try {
    const check = await admin.query(
      "SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('mailflow_owner', 'mailflow_app')) AS roles, to_regnamespace('mailflow') IS NOT NULL AS schema_exists",
    );
    if (check.rows[0].roles !== 0 || check.rows[0].schema_exists) throw new Error('Database is not fresh');
    await admin.query('BEGIN');
    try {
      await admin.query("SET LOCAL log_statement = 'none'; SET LOCAL log_min_error_statement = 'panic'");
      await admin.query(`CREATE ROLE mailflow_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${credentials.owner}'`);
      await admin.query(`CREATE ROLE mailflow_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${credentials.app}'`);
      await admin.query('ALTER DATABASE mailflow OWNER TO mailflow_owner');
      await admin.query('REVOKE ALL ON DATABASE mailflow FROM PUBLIC');
      await admin.query('GRANT CONNECT ON DATABASE mailflow TO mailflow_app');
      await admin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
  } finally {
    await admin.end();
  }

  const owner = connect('mailflow_owner', credentials.owner);
  await owner.connect();
  try {
    const migration = fs.readFileSync('/tmp/mailflow-deploy/001_persistence_foundation.sql', 'utf8');
    await owner.query(migration);
    await owner.query('REVOKE ALL ON SCHEMA mailflow FROM PUBLIC');
    await owner.query('GRANT USAGE ON SCHEMA mailflow TO mailflow_app');
    await owner.query('GRANT SELECT ON mailflow.schema_migrations TO mailflow_app');
    await owner.query('GRANT SELECT, INSERT ON mailflow.messages, mailflow.classifications, mailflow.policy_decisions, mailflow.workflow_runs, mailflow.action_log TO mailflow_app');
    await owner.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mailflow TO mailflow_app');
    console.log('Dedicated roles created; migration 1 applied as mailflow_owner and runtime grants installed.');
  } finally {
    await owner.end();
  }
}

main().catch((error) => {
  console.error(`Provisioning failed${typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? ` (SQLSTATE ${error.code})` : ''}; inspect database state before retrying.`);
  process.exitCode = 1;
});

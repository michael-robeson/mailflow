'use strict';

const fs = require('node:fs');
const { persistLiveBatch } = require('./live-persistence.cjs');

async function persistForN8n(runId, accountKey, processed) {
  let pool;
  try {
    const secret = fs.readFileSync('/run/mailflow/app-password', 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid application credential');
    const { Pool } = require('pg');
    pool = new Pool({
      host: 'mailflow-postgres', port: 5432, database: 'mailflow',
      user: 'mailflow_app', password: secret, connectionTimeoutMillis: 10000,
    });
    return await persistLiveBatch(pool, runId, accountKey, processed);
  } catch {
    throw new Error('Mailflow persistence failed; transaction outcome may be unknown. Retry only with identical input and the same run ID.');
  } finally {
    if (pool) await pool.end();
  }
}

module.exports = { persistForN8n };

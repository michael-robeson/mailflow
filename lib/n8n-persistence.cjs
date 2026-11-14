'use strict';

const fs = require('node:fs');
const { persistLiveBatch } = require('./live-persistence.cjs');
const { openHistoricalIngestion, persistHistoricalPage, saveHistoricalCheckpoint, historicalReport } = require('./historical-ingestion.cjs');

function createPool() {
  const secret = fs.readFileSync('/run/mailflow/app-password', 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid application credential');
  const { Pool } = require('pg');
  return new Pool({
    host: 'mailflow-postgres', port: 5432, database: 'mailflow',
    user: 'mailflow_app', password: secret, connectionTimeoutMillis: 10000,
  });
}

async function persistForN8n(runId, accountKey, processed) {
  let pool;
  try {
    pool = createPool();
    return await persistLiveBatch(pool, runId, accountKey, processed);
  } catch {
    throw new Error('Mailflow persistence failed; transaction outcome may be unknown. Retry only with identical input and the same run ID.');
  } finally {
    if (pool) await pool.end();
  }
}

async function persistHistoricalForN8n(state, processed) {
  let pool;
  try {
    pool = createPool();
    const result = await persistHistoricalPage(pool, state, processed);
    if (result.failed > state.failed) return historicalReport(result, true);
    await saveHistoricalCheckpoint(pool, result);
    return historicalReport(result);
  } catch {
    throw new Error('Historical persistence failed; outcome may be unknown. Restart with the same ingestion UUID and configuration.');
  } finally {
    if (pool) await pool.end();
  }
}

async function openHistoricalForN8n(config) {
  let pool;
  try {
    pool = createPool();
    return await openHistoricalIngestion(pool, config);
  } catch {
    throw new Error('Could not open historical ingestion. Verify configuration, migration and database access.');
  } finally {
    if (pool) await pool.end();
  }
}

module.exports = { persistForN8n, openHistoricalForN8n, persistHistoricalForN8n };

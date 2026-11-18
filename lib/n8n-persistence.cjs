'use strict';

const fs = require('node:fs');
const { persistLiveBatch } = require('./live-persistence.cjs');
const {
  openHistoricalIngestion,
  versionedMessageRunId,
  persistHistoricalPage,
  persistVersionedLivePage,
  saveHistoricalCheckpoint,
  historicalReport,
} = require('./historical-ingestion.cjs');
const { processVersionedBatch } = require('./versioned-pipeline.cjs');
const { createVersionedPersistenceAdapter } = require('./versioned-persistence.cjs');

function createPool() {
  const secret = fs.readFileSync('/run/mailflow/app-password', 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid application credential');
  const { Pool } = require('pg');
  return new Pool({
    host: 'mailflow-postgres',
    port: 5432,
    database: 'mailflow',
    user: 'mailflow_app',
    password: secret,
    connectionTimeoutMillis: 10000,
  });
}

async function persistForN8n(runId, accountKey, processed) {
  let pool;
  try {
    pool = createPool();
    return await persistLiveBatch(pool, runId, accountKey, processed);
  } catch {
    throw new Error(
      'Mailflow persistence failed; transaction outcome may be unknown. Retry only with identical input and the same run ID.',
    );
  } finally {
    if (pool) await pool.end();
  }
}

async function persistHistoricalForN8n(state, processed) {
  const result = await persistHistoricalPageForN8n(state, processed);
  return historicalReport(result.state, result.retryCurrentPage);
}

async function persistVersionedLivePageForN8n(previous, page, responses) {
  let pool;
  try {
    pool = createPool();
    return (await persistVersionedLivePage(pool, previous, page, responses)).report;
  } catch {
    throw new Error(
      'M1 live page failed; checkpoint may be unchanged or the commit outcome may be unknown. Retry with the same ingestion UUID and configuration.',
    );
  } finally {
    if (pool) await pool.end();
  }
}

async function persistHistoricalPageForN8n(state, processed) {
  let pool;
  try {
    pool = createPool();
    const result = await persistHistoricalPage(pool, state, processed);
    if (result.failed > state.failed) return { state: result, retryCurrentPage: true };
    await saveHistoricalCheckpoint(pool, result);
    return { state: result, retryCurrentPage: false };
  } catch {
    throw new Error(
      'Historical persistence failed; outcome may be unknown. Restart with the same ingestion UUID and configuration.',
    );
  } finally {
    if (pool) await pool.end();
  }
}

async function persistVersionedHistoricalMessagesForN8n(state, messages) {
  if (
    state?.versionedEvaluation?.enabled !== true ||
    !Array.isArray(messages) ||
    messages.length > state.pageSize ||
    messages.length > 25
  ) {
    throw new TypeError('Invalid M1 historical evaluation request');
  }
  if (!messages.length) return { count: 0, alreadyProcessed: 0 };

  let pool;
  try {
    pool = createPool();
    const adapter = createVersionedPersistenceAdapter(pool);
    const revisionId = state.versionedEvaluation.configurationRevisionId;
    const configurationRevision =
      revisionId === null
        ? null
        : await adapter.getConfigurationRevision({
            accountKey: state.accountKey,
            revisionId,
          });
    let alreadyProcessed = 0;
    for (const message of messages) {
      const result = await processVersionedBatch({
        runId: versionedMessageRunId(state.ingestionId, state.accountKey, message?.id),
        accountKey: state.accountKey,
        configurationRevision,
        isHistoricalReplay: true,
        items: [{ message, makeCurrent: false }],
        persistenceAdapter: adapter,
      });
      if (result.persistence.alreadyProcessed) alreadyProcessed++;
    }
    return { count: messages.length, alreadyProcessed };
  } catch {
    throw new Error(
      'Versioned historical evaluation failed; outcome may be unknown. Resume with the same ingestion UUID and configuration.',
    );
  } finally {
    if (pool) await pool.end();
  }
}

async function openHistoricalForN8n(config) {
  let pool;
  try {
    pool = createPool();
    if (config?.enableM1 === true) {
      const migration = await pool.query(
        'SELECT 1 FROM mailflow.schema_migrations WHERE version = 3',
      );
      if (migration.rows.length !== 1) {
        throw new Error('Versioned evaluation persistence migration is not applied');
      }
    }
    const state = await openHistoricalIngestion(pool, config);
    if (state.versionedEvaluation && state.versionedEvaluation.configurationRevisionId !== null) {
      await createVersionedPersistenceAdapter(pool).getConfigurationRevision({
        accountKey: state.accountKey,
        revisionId: state.versionedEvaluation.configurationRevisionId,
      });
    }
    return state;
  } catch {
    throw new Error(
      'Could not open historical ingestion. Verify configuration, migration and database access.',
    );
  } finally {
    if (pool) await pool.end();
  }
}

module.exports = {
  persistForN8n,
  openHistoricalForN8n,
  persistHistoricalForN8n,
  persistHistoricalPageForN8n,
  persistVersionedLivePageForN8n,
  persistVersionedHistoricalMessagesForN8n,
};

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Pool } = require('pg');
const { processGmailResponse } = require('../../lib/gmail-live.cjs');
const {
  createHistoricalState,
  openHistoricalIngestion,
  prepareHistoricalPage,
  persistHistoricalPage,
  saveHistoricalCheckpoint,
  historicalLoopResult,
} = require('../../lib/historical-ingestion.cjs');

function message(id, number = 1) {
  return processGmailResponse(
    id,
    {
      statusCode: 200,
      body: {
        id,
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Subject', value: 'Job alert' }],
          body: { data: Buffer.from('New jobs matching your preferences.').toString('base64url') },
        },
      },
    },
    number,
  );
}

test('historical retries reuse message decisions across pages and retry failures', async (t) => {
  const pool = new Pool({
    host: '127.0.0.1',
    port: 5432,
    database: 'postgres',
    user: 'mailflow_test_app',
  });
  t.after(() => pool.end());
  const config = {
    ingestionId: '30000000-0000-4000-8000-000000000001',
    accountKey: 'synthetic_history',
    pageSize: 2,
    maxMessages: 4,
  };
  let state = await openHistoricalIngestion(pool, config);
  let page = prepareHistoricalPage(state, {
    messages: [{ id: 'synthetic_history_1' }, { id: 'synthetic_history_2' }],
    nextPageToken: 'next',
  });
  state = await persistHistoricalPage(pool, page.state, [
    message('synthetic_history_1'),
    processGmailResponse('synthetic_history_2', { statusCode: 404 }, 2),
  ]);
  assert.equal(state.persisted, 1);
  assert.equal(state.failed, 1);
  await assert.rejects(saveHistoricalCheckpoint(pool, state), /failed messages/);
  state = await openHistoricalIngestion(pool, config);
  assert.equal(state.pages, 0);
  page = prepareHistoricalPage(state, {
    messages: [{ id: 'synthetic_history_2' }, { id: 'synthetic_history_1' }],
  });
  state = await persistHistoricalPage(pool, page.state, [
    message('synthetic_history_2'),
    message('synthetic_history_1', 2),
  ]);
  assert.equal(state.persisted, 1);
  assert.equal(state.previouslyProcessed, 1);
  await saveHistoricalCheckpoint(pool, state);
  state = await openHistoricalIngestion(pool, config);
  assert.equal(state.pages, 1);
  assert.equal(state.hasMore, false);
  await assert.rejects(
    openHistoricalIngestion(pool, { ...config, pageSize: 1 }),
    /different configuration/,
  );
  await persistHistoricalPage(
    pool,
    createHistoricalState({ ...config, ingestionId: '30000000-0000-4000-8000-000000000002' }),
    [message('synthetic_history_1')],
  );
  const result = await pool.query(
    `SELECT
    (SELECT count(*)::int FROM mailflow.messages WHERE account_key = $1) AS messages,
    (SELECT count(*)::int FROM mailflow.workflow_runs WHERE account_key = $1) AS runs,
    (SELECT count(*)::int FROM mailflow.classifications WHERE account_key = $1) AS classifications,
    (SELECT count(*)::int FROM mailflow.policy_decisions p JOIN mailflow.classifications c ON c.id = p.classification_id WHERE c.account_key = $1) AS decisions`,
    [config.accountKey],
  );
  assert.deepEqual(result.rows[0], { messages: 2, runs: 3, classifications: 3, decisions: 3 });
});

test('multi-page checkpoints survive interruption and do not advance across failures', async (t) => {
  const pool = new Pool({
    host: '127.0.0.1',
    port: 5432,
    database: 'postgres',
    user: 'mailflow_test_app',
  });
  t.after(() => pool.end());
  const config = {
    ingestionId: '30000000-0000-4000-8000-000000000003',
    accountKey: 'synthetic_multi',
    pageSize: 2,
    maxMessages: 4,
  };
  let previous = await openHistoricalIngestion(pool, config);
  let page = prepareHistoricalPage(previous, {
    messages: [{ id: 'synthetic_multi_1' }, { id: 'synthetic_multi_2' }],
    nextPageToken: 'next',
  });
  let state = await persistHistoricalPage(pool, page.state, [
    message('synthetic_multi_1'),
    message('synthetic_multi_2'),
  ]);
  await saveHistoricalCheckpoint(pool, state);
  assert.equal(historicalLoopResult(previous, { state, retryCurrentPage: false }).continue, true);

  previous = await openHistoricalIngestion(pool, config);
  assert.equal(previous.pages, 1);
  page = prepareHistoricalPage(previous, {
    messages: [{ id: 'synthetic_multi_3' }, { id: 'synthetic_multi_4' }],
  });
  state = await persistHistoricalPage(pool, page.state, [
    message('synthetic_multi_3'),
    processGmailResponse('synthetic_multi_4', { statusCode: 503 }, 2),
  ]);
  assert.equal(
    historicalLoopResult(previous, { state, retryCurrentPage: true }).report.stopReason,
    'message_failure',
  );
  assert.equal((await openHistoricalIngestion(pool, config)).pages, 1);

  previous = await openHistoricalIngestion(pool, config);
  page = prepareHistoricalPage(previous, {
    messages: [{ id: 'synthetic_multi_3' }, { id: 'synthetic_multi_4' }],
  });
  state = await persistHistoricalPage(pool, page.state, [
    message('synthetic_multi_3'),
    message('synthetic_multi_4'),
  ]);
  await saveHistoricalCheckpoint(pool, state);
  const result = historicalLoopResult(previous, { state, retryCurrentPage: false });
  assert.equal(result.report.pages, 2);
  assert.equal(result.report.previouslyProcessed, 1);
  assert.equal(result.report.stopReason, 'limit');
  const counts = await pool.query(
    `SELECT
    (SELECT count(*)::int FROM mailflow.historical_checkpoints WHERE ingestion_id = $1) AS checkpoints,
    (SELECT count(*)::int FROM mailflow.workflow_runs WHERE account_key = $2) AS runs,
    (SELECT count(*)::int FROM mailflow.classifications WHERE account_key = $2) AS classifications,
    (SELECT count(*)::int FROM mailflow.policy_decisions p JOIN mailflow.classifications c ON c.id = p.classification_id WHERE c.account_key = $2) AS decisions`,
    [config.ingestionId, config.accountKey],
  );
  assert.deepEqual(counts.rows[0], { checkpoints: 2, runs: 4, classifications: 4, decisions: 4 });
});

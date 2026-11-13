'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Pool } = require('pg');
const { processGmailResponse } = require('../../lib/gmail-live.cjs');
const { persistLiveBatch } = require('../../lib/live-persistence.cjs');

test('mapped Gmail decisions persist with idempotent retries and historical classifications', async (t) => {
  const pool = new Pool({ host: '127.0.0.1', port: 5432, database: 'postgres', user: 'mailflow_test_app' });
  t.after(() => pool.end());
  const good = processGmailResponse('synthetic_live_1', { statusCode: 200, body: {
    id: 'synthetic_live_1', threadId: 'synthetic_thread',
    payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Job alert' }],
      body: { data: Buffer.from('New jobs matching your preferences.').toString('base64url') } },
  } }, 1);
  const failure = processGmailResponse('synthetic_live_2', { statusCode: 404 }, 2);
  const first = '20000000-0000-4000-8000-000000000001';
  const second = '20000000-0000-4000-8000-000000000002';
  const processed = [good, failure];
  const report = await persistLiveBatch(pool, first, 'synthetic_live', processed);
  assert.deepEqual(report.persistence, { count: 2, alreadyProcessed: false });
  assert.equal(report.retrievalErrors, 1);
  assert.equal((await persistLiveBatch(pool, first, 'synthetic_live', processed)).persistence.alreadyProcessed, true);
  await persistLiveBatch(pool, second, 'synthetic_live', processed);
  await assert.rejects(persistLiveBatch(pool, first, 'synthetic_live', [good]), /different input/);
  const result = await pool.query(`SELECT
    (SELECT count(*)::int FROM mailflow.messages WHERE account_key = $1) AS messages,
    (SELECT count(*)::int FROM mailflow.classifications WHERE account_key = $1) AS classifications,
    (SELECT count(*)::int FROM mailflow.policy_decisions p JOIN mailflow.classifications c ON c.id = p.classification_id WHERE c.account_key = $1) AS decisions`, ['synthetic_live']);
  assert.deepEqual(result.rows[0], { messages: 2, classifications: 4, decisions: 4 });
});

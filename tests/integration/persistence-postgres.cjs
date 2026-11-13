'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Pool } = require('pg');
const { createPersistenceAdapter } = require('../../lib/persistence.cjs');

const pool = new Pool({ host: '127.0.0.1', port: 5432, database: 'postgres', user: 'mailflow_test_app' });
const adapter = createPersistenceAdapter(pool);
const run1 = '10000000-0000-4000-8000-000000000001';
const run2 = '10000000-0000-4000-8000-000000000002';
const run3 = '10000000-0000-4000-8000-000000000003';
const otherRun = '10000000-0000-4000-8000-000000000004';
const item = {
  gmailMessageId: 'synthetic_message',
  receivedAt: '2026-01-01T00:00:00Z',
  classification: { category: 'job_alert', status: 'matched', matchedRuleIds: ['job_alert_digest'], explanationCodes: ['positive_rule_matched'] },
  policy: { action: 'weekly', status: 'decided', explanationCodes: ['default_action_selected'] },
};
const batch = (runId, accountKey = 'synthetic_account') => ({ runId, accountKey, items: [item] });

test('isolated PostgreSQL enforces identity, preserves history, and rolls back failed writes', async (t) => {
  t.after(() => pool.end());
  assert.equal((await adapter.persistBatch(batch(run1))).alreadyProcessed, false);
  assert.equal((await adapter.persistBatch(batch(run1))).alreadyProcessed, true);
  await assert.rejects(adapter.persistBatch({ ...batch(run1), items: [{ ...item, policy: { ...item.policy, action: 'daily' } }] }), /different input/);
  await adapter.persistBatch({ ...batch(run2), items: [{ ...item, classification: { ...item.classification, category: 'other' } }] });
  await adapter.persistBatch(batch(otherRun, 'another_account'));
  const counts = await pool.query(`SELECT
    (SELECT count(*)::int FROM mailflow.messages) AS messages,
    (SELECT count(*)::int FROM mailflow.classifications) AS classifications,
    (SELECT count(*)::int FROM mailflow.policy_decisions) AS policies,
    (SELECT count(*)::int FROM mailflow.workflow_runs) AS runs`);
  assert.deepEqual(counts.rows[0], { messages: 2, classifications: 3, policies: 3, runs: 3 });
  const history = await pool.query('SELECT category FROM mailflow.classifications WHERE run_id = ANY($1::uuid[]) ORDER BY category', [[run1, run2]]);
  assert.deepEqual(history.rows.map((row) => row.category), ['job_alert', 'other']);
  await assert.rejects(pool.query(
    'INSERT INTO mailflow.messages (account_key, gmail_message_id) VALUES ($1, $2)',
    ['synthetic_account', 'synthetic_message'],
  ), { code: '23505' });
  await pool.query('INSERT INTO mailflow.messages (account_key, gmail_message_id) VALUES ($1, $2)', ['boundary', 'a'.repeat(256)]);
  await assert.rejects(pool.query(
    'INSERT INTO mailflow.messages (account_key, gmail_message_id) VALUES ($1, $2)',
    ['boundary', 'a'.repeat(257)],
  ), { code: '23514' });
  await assert.rejects(pool.query(
    "INSERT INTO mailflow.policy_decisions (classification_id, action, status, explanation_codes) SELECT id, 'weekly', 'decided', ARRAY[]::text[] FROM mailflow.classifications LIMIT 1",
  ), { code: '23505' });
  await assert.rejects(pool.query(
    "INSERT INTO mailflow.classifications (account_key, message_id, run_id, category, status, matched_rule_ids, explanation_codes) SELECT 'another_account', id, $1, 'other', 'matched', ARRAY[]::text[], ARRAY[]::text[] FROM mailflow.messages WHERE account_key = 'synthetic_account'",
    [otherRun],
  ), { code: '23503' });
  await assert.rejects(pool.query(
    "INSERT INTO mailflow.classifications (account_key, message_id, run_id, category, status, matched_rule_ids, explanation_codes) SELECT account_key, id, $1, 'other', 'matched', ARRAY['bad code'], ARRAY[]::text[] FROM mailflow.messages WHERE account_key = 'synthetic_account'",
    [run1],
  ), { code: '23514' });
  await assert.rejects(pool.query(
    "INSERT INTO mailflow.action_log (id, account_key, message_id, action_type, outcome, occurred_at) SELECT $1, 'another_account', id, 'label', 'planned', now() FROM mailflow.messages WHERE account_key = 'synthetic_account'",
    ['20000000-0000-4000-8000-000000000001'],
  ), { code: '23503' });
  const realConnect = pool.connect.bind(pool);
  const failingAdapter = createPersistenceAdapter({
    async connect() {
      const client = await realConnect();
      return {
        query(sql, params) {
          if (sql.includes('INSERT INTO mailflow.policy_decisions')) throw new Error('synthetic injected failure');
          return client.query(sql, params);
        },
        release: () => client.release(),
      };
    },
  });
  const rollbackBatch = { ...batch(run3), items: [{ ...item, gmailMessageId: 'synthetic_rollback' }] };
  await assert.rejects(failingAdapter.persistBatch(rollbackBatch), /synthetic injected failure/);
  const rolledBack = await pool.query('SELECT count(*)::int AS count FROM mailflow.workflow_runs WHERE id = $1', [run3]);
  assert.equal(rolledBack.rows[0].count, 0);
  const classifications = await pool.query('SELECT count(*)::int AS count FROM mailflow.classifications WHERE run_id = $1', [run3]);
  assert.equal(classifications.rows[0].count, 0);
  const messages = await pool.query('SELECT count(*)::int AS count FROM mailflow.messages WHERE gmail_message_id = $1', ['synthetic_rollback']);
  assert.equal(messages.rows[0].count, 0);
  const results = await Promise.all([adapter.persistBatch(rollbackBatch), adapter.persistBatch(rollbackBatch)]);
  assert.deepEqual(results.map((result) => result.alreadyProcessed).sort(), [false, true]);
  await assert.rejects(pool.query(
    "INSERT INTO mailflow.policy_decisions (classification_id, action, status, explanation_codes) VALUES (99999, 'delete', 'decided', ARRAY[]::text[])",
  ), { code: '23514' });
  await assert.rejects(pool.query('DELETE FROM mailflow.classifications'), { code: '42501' });
  await assert.rejects(pool.query('UPDATE mailflow.messages SET received_at = NULL'), { code: '42501' });
  await assert.rejects(pool.query('INSERT INTO mailflow.schema_migrations (version) VALUES (2)'), { code: '42501' });
});

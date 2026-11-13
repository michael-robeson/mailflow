'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createPersistenceAdapter } = require('../../lib/persistence.cjs');

async function main() {
  const token = fs.readFileSync(0, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid synthetic test credentials');
  const pool = new Pool({ host: '127.0.0.1', port: 5432, database: 'mailflow', user: 'mailflow_app', password: token });
  const adapter = createPersistenceAdapter(pool);
  try {
    const accountKey = `synthetic_${randomUUID().replaceAll('-', '')}`;
    const run1 = randomUUID();
    const run2 = randomUUID();
    const run3 = randomUUID();
    const item = {
      gmailMessageId: 'synthetic_message',
      receivedAt: '2026-01-01T00:00:00Z',
      classification: { category: 'job_alert', status: 'matched', matchedRuleIds: ['job_alert_digest'], explanationCodes: ['positive_rule_matched'] },
      policy: { action: 'weekly', status: 'decided', explanationCodes: ['default_action_selected'] },
    };
    const batch = (runId, currentItem = item) => ({ runId, accountKey, items: [currentItem] });
    assert.equal((await adapter.persistBatch(batch(run1))).alreadyProcessed, false);
    assert.equal((await adapter.persistBatch(batch(run1))).alreadyProcessed, true);
    await assert.rejects(adapter.persistBatch(batch(run1, { ...item, policy: { ...item.policy, action: 'daily' } })), /different input/);
    await adapter.persistBatch(batch(run2, { ...item, classification: { ...item.classification, category: 'other' } }));
    const history = await pool.query(
      'SELECT category FROM mailflow.classifications WHERE account_key = $1 ORDER BY category', [accountKey],
    );
    assert.deepEqual(history.rows.map((row) => row.category), ['job_alert', 'other']);

    const realConnect = pool.connect.bind(pool);
    const failing = createPersistenceAdapter({
      async connect() {
        const client = await realConnect();
        return {
          query(sql, params) {
            if (sql.includes('INSERT INTO mailflow.policy_decisions')) throw new Error('synthetic injected failure');
            return client.query(sql, params);
          },
          release: (error) => client.release(error),
        };
      },
    });
    const rollbackItem = { ...item, gmailMessageId: 'synthetic_rollback' };
    await assert.rejects(failing.persistBatch(batch(run3, rollbackItem)), /synthetic injected failure/);
    const rollback = await pool.query(
      'SELECT (SELECT count(*)::int FROM mailflow.workflow_runs WHERE id = $1) AS runs, (SELECT count(*)::int FROM mailflow.messages WHERE account_key = $2 AND gmail_message_id = $3) AS messages',
      [run3, accountKey, rollbackItem.gmailMessageId],
    );
    assert.deepEqual(rollback.rows[0], { runs: 0, messages: 0 });
    const concurrent = await Promise.all([adapter.persistBatch(batch(run3, rollbackItem)), adapter.persistBatch(batch(run3, rollbackItem))]);
    assert.deepEqual(concurrent.map((result) => result.alreadyProcessed).sort(), [false, true]);

    const counts = await pool.query(
      `SELECT (SELECT count(*)::int FROM mailflow.messages WHERE account_key = $1) AS messages,
       (SELECT count(*)::int FROM mailflow.workflow_runs WHERE account_key = $1) AS runs,
       (SELECT count(*)::int FROM mailflow.classifications WHERE account_key = $1) AS classifications,
       (SELECT count(*)::int FROM mailflow.policy_decisions p JOIN mailflow.classifications c ON c.id = p.classification_id WHERE c.account_key = $1) AS decisions`,
      [accountKey],
    );
    assert.deepEqual(counts.rows[0], { messages: 2, runs: 3, classifications: 3, decisions: 3 });
    const columns = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'mailflow' AND column_name ~* '(body|subject|sender)'",
    );
    assert.equal(columns.rows.length, 0);
    const privileges = await pool.query(
      "SELECT has_schema_privilege(current_user, 'mailflow', 'CREATE') AS schema_create, has_schema_privilege(current_user, 'public', 'CREATE') AS public_create",
    );
    assert.deepEqual(privileges.rows[0], { schema_create: false, public_create: false });
    await assert.rejects(pool.query('ALTER TABLE mailflow.messages ADD COLUMN forbidden text'), { code: '42501' });
    await assert.rejects(pool.query('UPDATE mailflow.messages SET received_at = NULL'), { code: '42501' });
    await assert.rejects(pool.query('DELETE FROM mailflow.classifications'), { code: '42501' });
    const migration = await pool.query('SELECT version FROM mailflow.schema_migrations ORDER BY version');
    assert.deepEqual(migration.rows.map((row) => row.version), [1]);
    console.log('Synthetic verification passed: 2 messages, 3 runs, 3 classifications, 3 decisions; retry, conflict, history, rollback, concurrency, privacy and permissions verified.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Synthetic verification failed${typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? ` (SQLSTATE ${error.code})` : ''}.`);
  process.exitCode = 1;
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPersistenceAdapter } = require('../lib/persistence.cjs');

const runId = '12345678-1234-4234-8234-123456789abc';
function batch() {
  return {
    runId,
    accountKey: 'account_1',
    items: [{
      gmailMessageId: 'message_1',
      receivedAt: '2026-01-02T03:04:05Z',
      classification: {
        category: 'job_alert', status: 'matched',
        matchedRuleIds: ['job_alert_digest'], explanationCodes: ['positive_rule_matched'],
      },
      policy: { action: 'weekly', status: 'decided', explanationCodes: ['default_action_selected'] },
    }],
  };
}

function fakePool({ duplicate = false, conflict = false, fail = false, rollbackFail = false } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === 'ROLLBACK' && rollbackFail) throw new Error('rollback failed');
      if (sql.includes('INSERT INTO mailflow.workflow_runs')) {
        this.run = params;
        return { rows: duplicate ? [] : [{ id: params[0] }] };
      }
      if (sql.includes('SELECT account_key, batch_hash')) {
        return { rows: [{ account_key: this.run[1], batch_hash: conflict ? 'different' : this.run[2] }] };
      }
      if (sql.includes('SELECT id FROM mailflow.messages')) return { rows: [{ id: '1' }] };
      if (sql.includes('INSERT INTO mailflow.classifications')) return { rows: [{ id: '2' }] };
      if (sql.includes('INSERT INTO mailflow.policy_decisions') && fail) throw new Error('synthetic failure');
      return { rows: [] };
    },
    release() { released = true; },
  };
  return { calls, connect: async () => client, isReleased: () => released };
}

test('persistence uses one transaction and parameterized statements', async () => {
  const pool = fakePool();
  assert.deepEqual(await createPersistenceAdapter(pool).persistBatch(batch()), {
    runId, alreadyProcessed: false, count: 1,
  });
  assert.equal(pool.calls[0].sql, 'BEGIN');
  assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  assert.ok(pool.isReleased());
  for (const { sql, params } of pool.calls.filter(({ params }) => params)) {
    assert.match(sql, /\$1/);
    assert.ok(!sql.includes('account_1'));
  }
});

test('a repeated run is idempotent and conflicting input is rejected', async () => {
  const pool = fakePool({ duplicate: true });
  assert.equal((await createPersistenceAdapter(pool).persistBatch(batch())).alreadyProcessed, true);
  assert.ok(!pool.calls.some(({ sql }) => sql.includes('INSERT INTO mailflow.messages')));
  const conflict = fakePool({ duplicate: true, conflict: true });
  await assert.rejects(createPersistenceAdapter(conflict).persistBatch(batch()), /different input/);
  assert.equal(conflict.calls.at(-1).sql, 'ROLLBACK');
});

test('write failures roll back and rollback failures remain visible', async () => {
  const pool = fakePool({ fail: true });
  await assert.rejects(createPersistenceAdapter(pool).persistBatch(batch()), /synthetic failure/);
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
  assert.ok(pool.isReleased());
  const broken = fakePool({ fail: true, rollbackFail: true });
  await assert.rejects(createPersistenceAdapter(broken).persistBatch(batch()), (error) =>
    error instanceof AggregateError && error.errors.length === 2);
  assert.ok(broken.isReleased());
});

test('invalid inputs are rejected before connecting and raw email fields are not accepted', async () => {
  for (const mutate of [
    (x) => { x.runId = 'invalid'; },
    (x) => { x.accountKey = ''; },
    (x) => { x.items[0].gmailMessageId = 'bad/id'; },
    (x) => { x.items[0].receivedAt = '2026-02-30T00:00:00Z'; },
    (x) => { x.items[0].body = 'synthetic body'; },
    (x) => { x.items[0].subject = 'synthetic subject'; },
    (x) => { x.items[0].classification.matchedRuleIds = ['not a code']; },
    (x) => { x.items[0].policy.action = 'delete'; },
    (x) => { x.items.push(x.items[0]); },
    (x) => { x.items = Array.from({ length: 26 }, (_, i) => ({ ...x.items[0], gmailMessageId: `m${i}` })); },
  ]) {
    const input = batch();
    mutate(input);
    let connected = false;
    await assert.rejects(createPersistenceAdapter({ connect: async () => { connected = true; } }).persistBatch(input), TypeError);
    assert.equal(connected, false);
  }
});

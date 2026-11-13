'use strict';

const { createHash } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]+$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const ACTIONS = new Set(['immediate', 'daily', 'weekly', 'none']);

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some((key) => !keys.includes(key))) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function identifier(value, regex, max, label) {
  if (typeof value !== 'string' || value.length > max || !regex.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function codes(value, label) {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError(`Invalid ${label}`);
  return value.map((code) => identifier(code, CODE, 64, label));
}

function timestamp(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return new Date(value).toISOString();
}

function validateBatch(input) {
  object(input, ['runId', 'accountKey', 'items'], 'batch');
  const runId = identifier(input.runId, UUID, 36, 'run ID').toLowerCase();
  const accountKey = identifier(input.accountKey, ID, 128, 'account key');
  if (!Array.isArray(input.items) || input.items.length > 25) throw new TypeError('Invalid batch items');
  const seen = new Set();
  const items = input.items.map((item) => {
    object(item, ['gmailMessageId', 'receivedAt', 'classification', 'policy'], 'item');
    const gmailMessageId = identifier(item.gmailMessageId, ID, 256, 'Gmail message ID');
    if (seen.has(gmailMessageId)) throw new TypeError('Duplicate Gmail message ID');
    seen.add(gmailMessageId);
    object(item.classification, ['category', 'status', 'matchedRuleIds', 'explanationCodes'], 'classification');
    object(item.policy, ['action', 'status', 'explanationCodes'], 'policy');
    const classification = {
      category: identifier(item.classification.category, CODE, 64, 'classification category'),
      status: identifier(item.classification.status, CODE, 64, 'classification status'),
      matchedRuleIds: codes(item.classification.matchedRuleIds, 'matched rule IDs'),
      explanationCodes: codes(item.classification.explanationCodes, 'classification explanation codes'),
    };
    if (!ACTIONS.has(item.policy.action)) throw new TypeError('Invalid policy action');
    return {
      gmailMessageId,
      receivedAt: timestamp(item.receivedAt, 'received timestamp'),
      classification,
      policy: {
        action: item.policy.action,
        status: identifier(item.policy.status, CODE, 64, 'policy status'),
        explanationCodes: codes(item.policy.explanationCodes, 'policy explanation codes'),
      },
    };
  });
  return { runId, accountKey, items };
}

function createPersistenceAdapter(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required');

  async function persistBatch(input) {
    const batch = validateBatch(input);
    const hash = createHash('sha256').update(JSON.stringify(batch)).digest('hex');
    const client = await pool.connect();
    let active = false;
    let releaseError;
    try {
      await client.query('BEGIN');
      active = true;
      const inserted = await client.query(
        'INSERT INTO mailflow.workflow_runs (id, account_key, batch_hash) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id',
        [batch.runId, batch.accountKey, hash],
      );
      if (inserted.rows.length === 0) {
        const existing = await client.query('SELECT account_key, batch_hash FROM mailflow.workflow_runs WHERE id = $1', [batch.runId]);
        if (existing.rows.length !== 1 || existing.rows[0].account_key !== batch.accountKey ||
            existing.rows[0].batch_hash !== hash) {
          throw new Error('Run ID already exists with different input');
        }
        await client.query('COMMIT');
        active = false;
        return { runId: batch.runId, alreadyProcessed: true, count: batch.items.length };
      }
      for (const item of batch.items) {
        await client.query(
          'INSERT INTO mailflow.messages (account_key, gmail_message_id, received_at) VALUES ($1, $2, $3) ON CONFLICT (account_key, gmail_message_id) DO NOTHING',
          [batch.accountKey, item.gmailMessageId, item.receivedAt],
        );
        const message = await client.query(
          'SELECT id FROM mailflow.messages WHERE account_key = $1 AND gmail_message_id = $2',
          [batch.accountKey, item.gmailMessageId],
        );
        if (message.rows.length !== 1) throw new Error('Message could not be located');
        const classification = await client.query(
          'INSERT INTO mailflow.classifications (account_key, message_id, run_id, category, status, matched_rule_ids, explanation_codes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
          [batch.accountKey, message.rows[0].id, batch.runId, item.classification.category,
            item.classification.status, item.classification.matchedRuleIds, item.classification.explanationCodes],
        );
        await client.query(
          'INSERT INTO mailflow.policy_decisions (classification_id, action, status, explanation_codes) VALUES ($1, $2, $3, $4)',
          [classification.rows[0].id, item.policy.action, item.policy.status, item.policy.explanationCodes],
        );
      }
      await client.query('COMMIT');
      active = false;
      return { runId: batch.runId, alreadyProcessed: false, count: batch.items.length };
    } catch (error) {
      if (active) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          releaseError = rollbackError;
          throw new AggregateError([error, rollbackError], 'Persistence failed and rollback failed');
        }
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  return { persistBatch };
}

module.exports = { createPersistenceAdapter };

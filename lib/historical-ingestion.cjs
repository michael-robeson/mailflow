'use strict';

const { createHash } = require('node:crypto');
const { prepareGmailMessageList } = require('./gmail-live.cjs');
const { createLivePersistenceBatch } = require('./live-persistence.cjs');
const { createPersistenceAdapter } = require('./persistence.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[A-Za-z0-9_-]{1,128}$/;

function createHistoricalState({ ingestionId, accountKey, query = '', pageSize = 25, maxMessages = 100 }) {
  if (typeof ingestionId !== 'string' || !UUID.test(ingestionId)) throw new Error('Configure an explicit ingestion UUID');
  if (typeof accountKey !== 'string' || !ACCOUNT.test(accountKey)) throw new Error('Invalid account key');
  if (typeof query !== 'string' || query.length > 1024) throw new Error('Invalid Gmail query');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 25) throw new Error('Invalid page size');
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 1000) throw new Error('Invalid maximum message count');
  return {
    ingestionId: ingestionId.toLowerCase(), accountKey, query, pageSize, maxMessages,
    nextPageToken: null, seenPageTokens: [], pages: 0,
    discovered: 0, processed: 0, persisted: 0, previouslyProcessed: 0, failed: 0,
    categoryCounts: {}, actionCounts: {}, hasMore: true,
  };
}

function prepareHistoricalPage(state, response) {
  if (!state.hasMore) throw new Error('Pagination already completed');
  const limit = Math.min(state.pageSize, state.maxMessages - state.discovered);
  const messages = prepareGmailMessageList(response, limit);
  const token = response.nextPageToken;
  if (token !== undefined && (typeof token !== 'string' || token.length === 0 || token.length > 4096)) {
    throw new Error('Invalid Gmail page token');
  }
  if (token && state.seenPageTokens.includes(token)) throw new Error('Repeated Gmail page token');
  if (!messages.length && token) throw new Error('Gmail pagination made no progress');
  return {
    state: {
      ...state,
      discovered: state.discovered + messages.length,
      pages: state.pages + 1,
      nextPageToken: token ?? null,
      seenPageTokens: token ? [...state.seenPageTokens, token] : state.seenPageTokens,
      hasMore: Boolean(token && state.discovered + messages.length < state.maxMessages),
    },
    messages,
  };
}

function messageRunId(ingestionId, accountKey, messageId) {
  const digest = createHash('sha256')
    .update(JSON.stringify(['mailflow-historical-v1', ingestionId, accountKey, messageId]))
    .digest('hex').slice(0, 32).split('');
  digest[12] = '8';
  digest[16] = ((parseInt(digest[16], 16) & 3) | 8).toString(16);
  const hex = digest.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function openHistoricalIngestion(pool, config) {
  const initial = createHistoricalState(config);
  const configHash = createHash('sha256').update(JSON.stringify([
    'mailflow-historical-config-v1', initial.accountKey, initial.query, initial.pageSize, initial.maxMessages,
  ])).digest('hex');
  await pool.query(
    'INSERT INTO mailflow.historical_ingestions (id, account_key, config_hash) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
    [initial.ingestionId, initial.accountKey, configHash],
  );
  const ingestion = await pool.query(
    'SELECT account_key, config_hash FROM mailflow.historical_ingestions WHERE id = $1',
    [initial.ingestionId],
  );
  if (ingestion.rows.length !== 1 || ingestion.rows[0].account_key !== initial.accountKey ||
      ingestion.rows[0].config_hash !== configHash) {
    throw new Error('Ingestion UUID already exists with different configuration');
  }
  const checkpoint = await pool.query(
    'SELECT page_number, state FROM mailflow.historical_checkpoints WHERE ingestion_id = $1 ORDER BY page_number DESC LIMIT 1',
    [initial.ingestionId],
  );
  if (!checkpoint.rows.length) return initial;
  const saved = checkpoint.rows[0];
  const state = saved.state;
  const keys = ['nextPageToken', 'seenPageTokens', 'pages', 'discovered', 'processed', 'persisted',
    'previouslyProcessed', 'failed', 'categoryCounts', 'actionCounts', 'hasMore'];
  const validCounts = (counts) => counts && typeof counts === 'object' && !Array.isArray(counts) &&
    Object.entries(counts).every(([key, value]) => /^[a-z][a-z0-9_]{0,63}$/.test(key) &&
      Number.isInteger(value) && value >= 0 && value <= initial.maxMessages);
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      Object.keys(state).length !== keys.length || keys.some((key) => !Object.hasOwn(state, key)) ||
      !Number.isInteger(state.pages) || state.pages < 1 || state.pages > initial.maxMessages + 1 ||
      saved.page_number !== state.pages ||
      ['discovered', 'processed', 'persisted', 'previouslyProcessed', 'failed']
        .some((key) => !Number.isInteger(state[key]) || state[key] < 0 || state[key] > initial.maxMessages) ||
      state.failed !== 0 || typeof state.hasMore !== 'boolean' ||
      !Array.isArray(state.seenPageTokens) || state.seenPageTokens.length > initial.maxMessages ||
      state.seenPageTokens.some((token) => typeof token !== 'string' || !token.length || token.length > 4096) ||
      (state.nextPageToken !== null && (typeof state.nextPageToken !== 'string' ||
        !state.nextPageToken.length || state.nextPageToken.length > 4096)) ||
      (state.hasMore && (!state.nextPageToken || state.discovered >= initial.maxMessages)) ||
      !validCounts(state.categoryCounts) || !validCounts(state.actionCounts)) {
    throw new Error('Invalid historical checkpoint');
  }
  return { ...initial, ...state };
}

async function saveHistoricalCheckpoint(pool, state) {
  const { nextPageToken, seenPageTokens, pages, discovered, processed, persisted,
    previouslyProcessed, failed, categoryCounts, actionCounts, hasMore } = state;
  if (failed) throw new Error('Cannot checkpoint a page with failed messages');
  const result = await pool.query(
    'INSERT INTO mailflow.historical_checkpoints (ingestion_id, page_number, state) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING page_number',
    [state.ingestionId, pages, { nextPageToken, seenPageTokens, pages, discovered, processed,
      persisted, previouslyProcessed, failed, categoryCounts, actionCounts, hasMore }],
  );
  if (result.rows.length !== 1) throw new Error('Historical page checkpoint already exists; restart the ingestion');
}

async function persistHistoricalPage(pool, state, processed) {
  if (!Array.isArray(processed) || processed.length > state.pageSize) throw new Error('Invalid historical page');
  const next = {
    ...state,
    categoryCounts: { ...state.categoryCounts },
    actionCounts: { ...state.actionCounts },
  };
  const adapter = createPersistenceAdapter(pool);
  for (const item of processed) {
    const runId = messageRunId(state.ingestionId, state.accountKey, item.messageId);
    const existing = await pool.query(
      `SELECT c.category, p.action FROM mailflow.workflow_runs r
       LEFT JOIN mailflow.classifications c ON c.run_id = r.id AND c.account_key = r.account_key
       LEFT JOIN mailflow.policy_decisions p ON p.classification_id = c.id
       WHERE r.id = $1 AND r.account_key = $2`,
      [runId, state.accountKey],
    );
    if (existing.rows.length > 1 || (existing.rows.length === 1 && (!existing.rows[0].category || !existing.rows[0].action))) {
      throw new Error('Incomplete historical persistence record');
    }
    let category;
    let action;
    if (existing.rows.length) {
      ({ category, action } = existing.rows[0]);
      next.previouslyProcessed++;
    } else {
      next.processed++;
      if (item.decision.status === 'retrieval_error' || item.decision.status === 'processing_error') {
        next.failed++;
        continue;
      }
      const single = { ...item, decision: { ...item.decision, messageNumber: 1 } };
      const { batch } = createLivePersistenceBatch(runId, state.accountKey, [single]);
      const result = await adapter.persistBatch(batch);
      if (result.alreadyProcessed) next.previouslyProcessed++;
      else next.persisted++;
      category = item.decision.category;
      action = item.decision.action;
    }
    next.categoryCounts[category] = (next.categoryCounts[category] ?? 0) + 1;
    next.actionCounts[action] = (next.actionCounts[action] ?? 0) + 1;
  }
  return next;
}

function historicalReport(state, retryCurrentPage = false) {
  return {
    pages: state.pages, discovered: state.discovered, processed: state.processed,
    persisted: state.persisted, previouslyProcessed: state.previouslyProcessed, failed: state.failed,
    categoryCounts: state.categoryCounts, actionCounts: state.actionCounts,
    stoppedAtLimit: state.discovered >= state.maxMessages && Boolean(state.nextPageToken),
    hasMore: state.hasMore, retryCurrentPage,
  };
}

module.exports = {
  createHistoricalState, openHistoricalIngestion, prepareHistoricalPage,
  persistHistoricalPage, saveHistoricalCheckpoint, historicalReport,
};

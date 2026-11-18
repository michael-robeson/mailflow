'use strict';

const { createHash } = require('node:crypto');
const { GmailListError, prepareGmailMessageList } = require('./gmail-live.cjs');
const { createLivePersistenceBatch } = require('./live-persistence.cjs');
const { createPersistenceAdapter } = require('./persistence.cjs');
const {
  processVersionedBatch,
  VersionedMessageProcessingError,
} = require('./versioned-pipeline.cjs');
const { createVersionedPersistenceAdapter } = require('./versioned-persistence.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[A-Za-z0-9_-]{1,128}$/;

class HistoricalPaginationError extends Error {}

function createHistoricalState({
  ingestionId,
  accountKey,
  query = '',
  pageSize = 25,
  maxMessages = 100,
}) {
  if (typeof ingestionId !== 'string' || !UUID.test(ingestionId))
    throw new Error('Configure an explicit ingestion UUID');
  if (typeof accountKey !== 'string' || !ACCOUNT.test(accountKey))
    throw new Error('Invalid account key');
  if (typeof query !== 'string' || query.length > 1024) throw new Error('Invalid Gmail query');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 25)
    throw new Error('Invalid page size');
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 1000)
    throw new Error('Invalid maximum message count');
  return {
    ingestionId: ingestionId.toLowerCase(),
    accountKey,
    query,
    pageSize,
    maxMessages,
    nextPageToken: null,
    seenPageTokens: [],
    pages: 0,
    discovered: 0,
    processed: 0,
    persisted: 0,
    previouslyProcessed: 0,
    failed: 0,
    categoryCounts: {},
    actionCounts: {},
    hasMore: true,
  };
}

function prepareHistoricalPage(state, response) {
  if (!state.hasMore) throw new Error('Pagination already completed');
  const limit = Math.min(state.pageSize, state.maxMessages - state.discovered);
  let messages;
  try {
    messages = prepareGmailMessageList(response, limit);
  } catch (error) {
    if (!(error instanceof GmailListError)) throw error;
    throw new HistoricalPaginationError(error.message);
  }
  const token = response.nextPageToken;
  if (
    token !== undefined &&
    (typeof token !== 'string' || token.length === 0 || token.length > 4096)
  ) {
    throw new HistoricalPaginationError('Invalid Gmail page token');
  }
  if (token && state.seenPageTokens.includes(token))
    throw new HistoricalPaginationError('Repeated Gmail page token');
  if (!messages.length && token)
    throw new HistoricalPaginationError('Gmail pagination made no progress');
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
  return deterministicMessageRunId('mailflow-historical-v1', ingestionId, accountKey, messageId);
}

function versionedMessageRunId(ingestionId, accountKey, messageId) {
  return deterministicMessageRunId('mailflow-historical-m1-v1', ingestionId, accountKey, messageId);
}

function versionedLiveMessageRunId(ingestionId, accountKey, messageId) {
  return deterministicMessageRunId('mailflow-live-m1-v1', ingestionId, accountKey, messageId);
}

function deterministicMessageRunId(namespace, ingestionId, accountKey, messageId) {
  const digest = createHash('sha256')
    .update(JSON.stringify([namespace, ingestionId, accountKey, messageId]))
    .digest('hex')
    .slice(0, 32)
    .split('');
  digest[12] = '8';
  digest[16] = ((parseInt(digest[16], 16) & 3) | 8).toString(16);
  const hex = digest.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function versionedEvaluationConfiguration(config) {
  const enabled = config.enableM1 ?? false;
  const configurationRevisionId = config.configurationRevisionId ?? null;
  if (typeof enabled !== 'boolean') throw new Error('Invalid M1 enable flag');
  if (
    configurationRevisionId !== null &&
    (!Number.isSafeInteger(configurationRevisionId) || configurationRevisionId < 1)
  ) {
    throw new Error('Invalid M1 configuration revision ID');
  }
  if (!enabled && configurationRevisionId !== null) {
    throw new Error('An M1 configuration revision requires explicit M1 enablement');
  }
  return enabled ? { enabled: true, configurationRevisionId } : null;
}

function historicalConfigHash(initial, versionedEvaluation) {
  const components = [
    'mailflow-historical-config-v1',
    initial.accountKey,
    initial.query,
    initial.pageSize,
    initial.maxMessages,
  ];
  if (versionedEvaluation) {
    components.push(['mailflow-historical-m1-config-v1', versionedEvaluation]);
  }
  return createHash('sha256').update(JSON.stringify(components)).digest('hex');
}

function withVersionedEvaluation(state, versionedEvaluation) {
  return versionedEvaluation ? { ...state, versionedEvaluation } : state;
}

async function openHistoricalIngestion(pool, config) {
  const initial = createHistoricalState(config);
  const versionedEvaluation = versionedEvaluationConfiguration(config);
  const configHash = historicalConfigHash(initial, versionedEvaluation);
  await pool.query(
    'INSERT INTO mailflow.historical_ingestions (id, account_key, config_hash) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
    [initial.ingestionId, initial.accountKey, configHash],
  );
  const ingestion = await pool.query(
    'SELECT account_key, config_hash FROM mailflow.historical_ingestions WHERE id = $1',
    [initial.ingestionId],
  );
  if (
    ingestion.rows.length !== 1 ||
    ingestion.rows[0].account_key !== initial.accountKey ||
    ingestion.rows[0].config_hash !== configHash
  ) {
    throw new Error('Ingestion UUID already exists with different configuration');
  }
  const checkpoint = await pool.query(
    'SELECT page_number, state FROM mailflow.historical_checkpoints WHERE ingestion_id = $1 ORDER BY page_number DESC LIMIT 1',
    [initial.ingestionId],
  );
  if (!checkpoint.rows.length) {
    return withVersionedEvaluation(initial, versionedEvaluation);
  }
  const saved = checkpoint.rows[0];
  const state = saved.state;
  const keys = [
    'nextPageToken',
    'seenPageTokens',
    'pages',
    'discovered',
    'processed',
    'persisted',
    'previouslyProcessed',
    'failed',
    'categoryCounts',
    'actionCounts',
    'hasMore',
  ];
  const validCounts = (counts) =>
    counts &&
    typeof counts === 'object' &&
    !Array.isArray(counts) &&
    Object.entries(counts).every(
      ([key, value]) =>
        /^[a-z][a-z0-9_]{0,63}$/.test(key) &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= initial.maxMessages,
    );
  if (
    !state ||
    typeof state !== 'object' ||
    Array.isArray(state) ||
    Object.keys(state).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(state, key)) ||
    !Number.isInteger(state.pages) ||
    state.pages < 1 ||
    state.pages > initial.maxMessages + 1 ||
    saved.page_number !== state.pages ||
    ['discovered', 'processed', 'persisted', 'previouslyProcessed', 'failed'].some(
      (key) => !Number.isInteger(state[key]) || state[key] < 0 || state[key] > initial.maxMessages,
    ) ||
    state.failed !== 0 ||
    typeof state.hasMore !== 'boolean' ||
    !Array.isArray(state.seenPageTokens) ||
    state.seenPageTokens.length > initial.maxMessages ||
    state.seenPageTokens.some(
      (token) => typeof token !== 'string' || !token.length || token.length > 4096,
    ) ||
    (state.nextPageToken !== null &&
      (typeof state.nextPageToken !== 'string' ||
        !state.nextPageToken.length ||
        state.nextPageToken.length > 4096)) ||
    (state.hasMore && (!state.nextPageToken || state.discovered >= initial.maxMessages)) ||
    !validCounts(state.categoryCounts) ||
    !validCounts(state.actionCounts)
  ) {
    throw new Error('Invalid historical checkpoint');
  }
  const resumed = { ...initial, ...state };
  return withVersionedEvaluation(resumed, versionedEvaluation);
}

async function saveHistoricalCheckpoint(pool, state) {
  const {
    nextPageToken,
    seenPageTokens,
    pages,
    discovered,
    processed,
    persisted,
    previouslyProcessed,
    failed,
    categoryCounts,
    actionCounts,
    hasMore,
  } = state;
  if (failed) throw new Error('Cannot checkpoint a page with failed messages');
  const result = await pool.query(
    'INSERT INTO mailflow.historical_checkpoints (ingestion_id, page_number, state) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING page_number',
    [
      state.ingestionId,
      pages,
      {
        nextPageToken,
        seenPageTokens,
        pages,
        discovered,
        processed,
        persisted,
        previouslyProcessed,
        failed,
        categoryCounts,
        actionCounts,
        hasMore,
      },
    ],
  );
  if (result.rows.length !== 1)
    throw new Error('Historical page checkpoint already exists; restart the ingestion');
}

async function persistHistoricalPage(pool, state, processed) {
  if (!Array.isArray(processed) || processed.length > state.pageSize)
    throw new Error('Invalid historical page');
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
    if (
      existing.rows.length > 1 ||
      (existing.rows.length === 1 && (!existing.rows[0].category || !existing.rows[0].action))
    ) {
      throw new Error('Incomplete historical persistence record');
    }
    let category;
    let action;
    if (existing.rows.length) {
      ({ category, action } = existing.rows[0]);
      next.previouslyProcessed++;
    } else {
      next.processed++;
      if (
        item.decision.status === 'retrieval_error' ||
        item.decision.status === 'processing_error'
      ) {
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

async function persistVersionedLivePage(pool, previous, page, responses) {
  if (
    previous?.versionedEvaluation?.enabled !== true ||
    !page?.state ||
    !Array.isArray(page.messages) ||
    page.messages.length > previous.pageSize ||
    !Array.isArray(responses) ||
    responses.length !== page.messages.length
  ) {
    throw new Error('Invalid versioned live page');
  }
  historicalLoopResult(previous, { state: page.state, retryCurrentPage: false });

  const adapter = createVersionedPersistenceAdapter(pool);
  const configurationRevisionId = previous.versionedEvaluation.configurationRevisionId;
  const configurationRevision =
    configurationRevisionId === null
      ? null
      : await adapter.getConfigurationRevision({
          accountKey: previous.accountKey,
          revisionId: configurationRevisionId,
        });
  const next = {
    ...page.state,
    processed: previous.processed,
    persisted: previous.persisted,
    previouslyProcessed: previous.previouslyProcessed,
    failed: previous.failed,
    categoryCounts: { ...previous.categoryCounts },
    actionCounts: { ...previous.actionCounts },
  };
  const results = [];
  let currentEffectiveSelected = 0;
  let resolvedConfiguration = null;

  for (let index = 0; index < page.messages.length; index++) {
    const messageId = page.messages[index].id;
    const response = responses[index];
    if (!response || response.messageId !== messageId) {
      throw new Error('Invalid Gmail response association');
    }

    if (
      !Number.isInteger(response.statusCode) ||
      response.statusCode < 200 ||
      response.statusCode >= 300 ||
      response.hasError ||
      !response.body ||
      typeof response.body !== 'object' ||
      Array.isArray(response.body) ||
      response.body.id !== messageId
    ) {
      next.processed++;
      next.failed++;
      results.push({
        messageNumber: index + 1,
        status: 'retrieval_error',
        classification: {
          category: 'other',
          status: 'retrieval_error',
          matchedRuleIds: [],
          explanationCodes: ['gmail_message_retrieval_failed'],
        },
        tagging: { schemaVersion: '1.0', assignments: [] },
        policy: { action: 'none', status: 'retrieval_error', explanationCodes: [] },
        currentEffectiveSelected: false,
      });
      continue;
    }

    let evaluation;
    try {
      evaluation = await processVersionedBatch({
        runId: versionedLiveMessageRunId(previous.ingestionId, previous.accountKey, messageId),
        accountKey: previous.accountKey,
        configurationRevision,
        isHistoricalReplay: false,
        items: [{ message: response.body, makeCurrent: true }],
        persistenceAdapter: adapter,
      });
    } catch (error) {
      if (!(error instanceof VersionedMessageProcessingError)) throw error;
      next.processed++;
      next.failed++;
      results.push({
        messageNumber: index + 1,
        status: 'processing_error',
        classification: {
          category: 'other',
          status: 'processing_error',
          matchedRuleIds: [],
          explanationCodes: ['message_processing_failed'],
        },
        tagging: { schemaVersion: '1.0', assignments: [] },
        policy: { action: 'none', status: 'processing_error', explanationCodes: [] },
        currentEffectiveSelected: false,
      });
      continue;
    }

    const result = evaluation.results[0];
    if (evaluation.persistence.alreadyProcessed) {
      next.previouslyProcessed++;
    } else {
      next.processed++;
      next.persisted++;
    }
    next.categoryCounts[result.classification.category] =
      (next.categoryCounts[result.classification.category] ?? 0) + 1;
    next.actionCounts[result.policy.action] = (next.actionCounts[result.policy.action] ?? 0) + 1;
    currentEffectiveSelected++;
    resolvedConfiguration = evaluation.configuration;
    results.push({
      messageNumber: index + 1,
      status: result.policy.status,
      classification: result.classification,
      tagging: result.tagging,
      policy: result.policy,
      currentEffectiveSelected: true,
    });
  }

  const retryCurrentPage = next.failed > previous.failed;
  if (!retryCurrentPage) await saveHistoricalCheckpoint(pool, next);
  const reportState = retryCurrentPage
    ? { ...next, pages: previous.pages, stoppedAtLimit: false, hasMore: previous.hasMore }
    : next;
  const reportCounts = historicalReport(reportState, retryCurrentPage);
  return {
    state: retryCurrentPage ? previous : next,
    retryCurrentPage,
    report: {
      schemaVersion: '2.0',
      ...reportCounts,
      stoppedAtLimit: retryCurrentPage ? false : reportCounts.stoppedAtLimit,
      configuration:
        resolvedConfiguration ??
        (configurationRevision
          ? {
              builtInDefaultsVersion: 'mailflow-m1.2',
              configurationRevision: {
                revisionId: configurationRevision.revisionId,
                version: configurationRevision.version,
                digest: configurationRevision.digest,
              },
            }
          : { builtInDefaultsVersion: 'mailflow-m1.2', configurationRevision: null }),
      currentEffectiveSelected,
      results,
    },
  };
}

function historicalReport(state, retryCurrentPage = false) {
  return {
    pages: state.pages,
    discovered: state.discovered,
    processed: state.processed,
    persisted: state.persisted,
    previouslyProcessed: state.previouslyProcessed,
    failed: state.failed,
    categoryCounts: state.categoryCounts,
    actionCounts: state.actionCounts,
    stoppedAtLimit: state.discovered >= state.maxMessages && Boolean(state.nextPageToken),
    hasMore: state.hasMore,
    retryCurrentPage,
  };
}

function assertHistoricalConfigurationMatches(previous, state) {
  for (const key of ['ingestionId', 'accountKey', 'query', 'pageSize', 'maxMessages']) {
    if (state[key] !== previous[key]) throw new Error('Historical page configuration changed');
  }
  const previousM1 = previous.versionedEvaluation ?? null;
  const stateM1 = state.versionedEvaluation ?? null;
  if (
    previousM1?.enabled !== stateM1?.enabled ||
    previousM1?.configurationRevisionId !== stateM1?.configurationRevisionId
  ) {
    throw new Error('Historical M1 configuration changed');
  }
}

function historicalLoopResult(previous, page) {
  if (!previous || !page || !page.state || typeof page.retryCurrentPage !== 'boolean') {
    throw new Error('Invalid historical page result');
  }
  const state = page.state;
  assertHistoricalConfigurationMatches(previous, state);
  if (
    !previous.hasMore ||
    state.pages !== previous.pages + 1 ||
    !Number.isInteger(state.discovered) ||
    state.discovered < previous.discovered ||
    state.discovered > Math.min(previous.discovered + previous.pageSize, previous.maxMessages)
  ) {
    throw new Error('Historical pagination made no progress');
  }
  const token = state.nextPageToken;
  if (
    !Array.isArray(previous.seenPageTokens) ||
    !Array.isArray(state.seenPageTokens) ||
    (token !== null &&
      (typeof token !== 'string' ||
        !token.length ||
        token.length > 4096 ||
        previous.seenPageTokens.includes(token))) ||
    state.seenPageTokens.length !== previous.seenPageTokens.length + (token === null ? 0 : 1) ||
    previous.seenPageTokens.some((value, index) => state.seenPageTokens[index] !== value) ||
    (token !== null && state.seenPageTokens.at(-1) !== token) ||
    state.hasMore !== Boolean(token && state.discovered < state.maxMessages)
  ) {
    throw new Error('Invalid historical pagination state');
  }
  if (state.discovered === previous.discovered && state.hasMore) {
    throw new Error('Historical pagination made no progress');
  }
  if (page.retryCurrentPage) {
    if (state.failed <= previous.failed) throw new Error('Invalid historical retry state');
    return {
      state: previous,
      continue: false,
      report: {
        ...historicalReport(state, true),
        pages: previous.pages,
        stoppedAtLimit: false,
        hasMore: previous.hasMore,
        stopReason: 'message_failure',
      },
    };
  }
  if (state.failed !== previous.failed) throw new Error('Failed page cannot advance');
  return {
    state,
    continue: state.hasMore,
    report: state.hasMore ? null : historicalFinalReport(state),
  };
}

function historicalFinalReport(state, stopReason) {
  if (!stopReason) {
    if (state.hasMore) throw new Error('Historical ingestion has a pending page');
    stopReason = state.discovered >= state.maxMessages ? 'limit' : 'exhausted';
  }
  if (!['limit', 'exhausted', 'list_failure', 'pagination_failure'].includes(stopReason)) {
    throw new Error('Invalid historical stop reason');
  }
  return {
    ...historicalReport(state, ['list_failure', 'pagination_failure'].includes(stopReason)),
    stopReason,
  };
}

module.exports = {
  createHistoricalState,
  openHistoricalIngestion,
  prepareHistoricalPage,
  persistHistoricalPage,
  persistVersionedLivePage,
  messageRunId,
  versionedMessageRunId,
  versionedLiveMessageRunId,
  saveHistoricalCheckpoint,
  historicalReport,
  historicalLoopResult,
  historicalFinalReport,
  HistoricalPaginationError,
};

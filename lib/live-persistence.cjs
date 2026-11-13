'use strict';

const { sanitizeGmailReport } = require('./gmail-live.cjs');
const { createPersistenceAdapter } = require('./persistence.cjs');

function createLivePersistenceBatch(runId, accountKey, processed) {
  const report = sanitizeGmailReport(processed);
  const items = processed.map((item) => {
    if (!item.persistence || typeof item.persistence !== 'object') {
      throw new Error('Missing persistence data');
    }
    return {
      gmailMessageId: item.messageId,
      receivedAt: item.persistence.receivedAt,
      classification: item.persistence.classification,
      policy: item.persistence.policy,
    };
  });
  report.processingErrors = processed.filter((item) => item.decision.status === 'processing_error').length;
  report.retrievalErrors = processed.filter((item) => item.decision.status === 'retrieval_error').length;
  return { batch: { runId, accountKey, items }, report };
}

async function persistLiveBatch(pool, runId, accountKey, processed) {
  const { batch, report } = createLivePersistenceBatch(runId, accountKey, processed);
  const result = await createPersistenceAdapter(pool).persistBatch(batch);
  return { ...report, persistence: { count: result.count, alreadyProcessed: result.alreadyProcessed } };
}

module.exports = { createLivePersistenceBatch, persistLiveBatch };

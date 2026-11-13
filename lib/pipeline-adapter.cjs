'use strict';

const { normalizeGmailMessage } = require('./gmail-normalize.cjs');
const { classifyEmail } = require('./email-classify.cjs');
const { evaluateNotificationPolicy } = require('./notification-policy.cjs');

function failedDecision(messageNumber, explanationCode, status) {
  return {
    messageNumber,
    category: 'other',
    action: 'none',
    matchedRuleIds: [],
    explanationCodes: [explanationCode],
    status,
  };
}

function processMessage(message, messageNumber) {
  try {
    const normalized = normalizeGmailMessage(message);
    const classification = classifyEmail(normalized);
    const policy = evaluateNotificationPolicy(classification);
    return {
      messageNumber,
      category: policy.category,
      action: policy.action,
      matchedRuleIds: classification.status === 'matched' ? classification.matchedRuleIds : [],
      explanationCodes: [...classification.explanationCodes, ...policy.explanationCodes],
      status: policy.status,
    };
  } catch {
    return failedDecision(messageNumber, 'message_processing_failed', 'processing_error');
  }
}

function processSyntheticBatch(messages) {
  if (!Array.isArray(messages)) {
    return {
      schemaVersion: '1.0',
      results: [failedDecision(null, 'invalid_message_batch', 'invalid_input')],
    };
  }
  return {
    schemaVersion: '1.0',
    results: messages.map((message, index) => processMessage(message, index + 1)),
  };
}

module.exports = { processSyntheticBatch };

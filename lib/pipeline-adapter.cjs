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

function processMessageWithDiagnostics(message, messageNumber) {
  let diagnostics = null;
  try {
    const normalized = normalizeGmailMessage(message);
    diagnostics = {
      hasSubject: typeof normalized.subject === 'string' && normalized.subject.trim().length > 0,
      hasBody: normalized.body.trim().length > 0,
      hasSenderAddress: typeof normalized.sender.address === 'string' && normalized.sender.address.length > 0,
      hasWarnings: normalized.warnings.length > 0,
    };
    const classification = classifyEmail(normalized);
    const policy = evaluateNotificationPolicy(classification);
    return {
      decision: {
        messageNumber,
        category: policy.category,
        action: policy.action,
        matchedRuleIds: classification.status === 'matched' ? classification.matchedRuleIds : [],
        explanationCodes: [...classification.explanationCodes, ...policy.explanationCodes],
        status: policy.status,
      },
      diagnostics,
      persistence: {
        receivedAt: normalized.receivedAt,
        threadId: normalized.threadId,
        classification: {
          category: classification.category,
          status: classification.status,
          matchedRuleIds: classification.matchedRuleIds,
          explanationCodes: classification.explanationCodes,
        },
        policy: {
          action: policy.action,
          status: policy.status,
          explanationCodes: policy.explanationCodes,
        },
      },
    };
  } catch {
    return { decision: failedDecision(messageNumber, 'message_processing_failed', 'processing_error'), diagnostics };
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
    results: messages.map((message, index) => processMessageWithDiagnostics(message, index + 1).decision),
  };
}

module.exports = { processSyntheticBatch, processMessageWithDiagnostics };

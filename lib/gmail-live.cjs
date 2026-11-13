'use strict';

const { processMessageWithDiagnostics } = require('./pipeline-adapter.cjs');

const MAX_MESSAGES = 25;

function prepareGmailMessageList(response, limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGES) {
    throw new Error('Message limit must be an integer from 1 to 25');
  }
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.error) {
    throw new Error('Invalid Gmail list response');
  }
  const messages = response.messages === undefined ? [] : response.messages;
  if (!Array.isArray(messages) || messages.length > limit) {
    throw new Error('Invalid or oversized Gmail message list');
  }
  const ids = new Set();
  return messages.map((message) => {
    const id = message?.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) {
      throw new Error('Invalid or duplicate Gmail message ID');
    }
    ids.add(id);
    return { id };
  });
}

function retrievalFailure(messageNumber, code) {
  return {
    messageNumber,
    category: 'other',
    action: 'none',
    matchedRuleIds: [],
    explanationCodes: [code],
    status: 'retrieval_error',
  };
}

function processGmailResponse(id, response, messageNumber) {
  let decision;
  let diagnostics = null;
  try {
    if (!response || typeof response !== 'object' || response.error ||
        !Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 300) {
      decision = retrievalFailure(messageNumber, 'gmail_message_retrieval_failed');
    } else if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body) ||
        response.body.id !== id || !response.body.payload || typeof response.body.payload !== 'object' ||
        Array.isArray(response.body.payload) || !Array.isArray(response.body.payload.headers)) {
      decision = retrievalFailure(messageNumber, 'invalid_gmail_message_response');
    } else {
      ({ decision, diagnostics } = processMessageWithDiagnostics(response.body, messageNumber));
    }
  } catch {
    decision = {
      ...retrievalFailure(messageNumber, 'message_processing_failed'),
      status: 'processing_error',
    };
  }
  return { messageId: id, decision, diagnostics };
}

function sanitizeGmailReport(items) {
  if (!Array.isArray(items) || items.length > MAX_MESSAGES) {
    throw new Error('Invalid or oversized processed Gmail batch');
  }
  const diagnostics = {
    normalizedMessages: 0,
    messagesWithSubject: 0,
    messagesWithBody: 0,
    messagesWithSenderAddress: 0,
    messagesWithNormalizationWarnings: 0,
    categoryCounts: {},
    matchedRuleCounts: {},
  };
  const results = items.map((item, index) => {
    const decision = item?.decision;
    if (!decision || decision.messageNumber !== index + 1) {
      throw new Error('Invalid processed Gmail batch order');
    }
    if (item.diagnostics !== null) {
      const flags = item.diagnostics;
      if (!flags || ['hasSubject', 'hasBody', 'hasSenderAddress', 'hasWarnings']
        .some((key) => typeof flags[key] !== 'boolean')) {
        throw new Error('Invalid normalization diagnostics');
      }
      diagnostics.normalizedMessages++;
      if (flags.hasSubject) diagnostics.messagesWithSubject++;
      if (flags.hasBody) diagnostics.messagesWithBody++;
      if (flags.hasSenderAddress) diagnostics.messagesWithSenderAddress++;
      if (flags.hasWarnings) diagnostics.messagesWithNormalizationWarnings++;
    }
    diagnostics.categoryCounts[decision.category] = (diagnostics.categoryCounts[decision.category] ?? 0) + 1;
    for (const rule of decision.matchedRuleIds) {
      diagnostics.matchedRuleCounts[rule] = (diagnostics.matchedRuleCounts[rule] ?? 0) + 1;
    }
    return {
      messageNumber: decision.messageNumber,
      category: decision.category,
      action: decision.action,
      matchedRuleIds: decision.matchedRuleIds,
      explanationCodes: decision.explanationCodes,
      status: decision.status,
    };
  });
  return {
    schemaVersion: '1.0',
    results,
    diagnostics,
  };
}

module.exports = { prepareGmailMessageList, processGmailResponse, sanitizeGmailReport };

'use strict';

const { classifyEmail } = require('./email-classify.cjs');
const { resolveEffectiveConfiguration } = require('./effective-configuration.cjs');
const { normalizeGmailMessage } = require('./gmail-normalize.cjs');
const { evaluateNotificationPolicyV2 } = require('./notification-policy-v2.cjs');
const {
  assignBuiltInTags,
  tagDefinitionsForConfiguration,
  validateTaggingResult,
} = require('./tagging.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BATCH_SIZE = 25;

class VersionedMessageProcessingError extends Error {}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, keys, label) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function publicClassification(classification) {
  return {
    schemaVersion: classification.schemaVersion,
    category: classification.category,
    status: classification.status,
    matchedRuleIds: classification.matchedRuleIds,
    explanationCodes: classification.explanationCodes,
  };
}

async function processVersionedBatch(input) {
  exactObject(
    input,
    [
      'runId',
      'accountKey',
      'configurationRevision',
      'isHistoricalReplay',
      'items',
      'persistenceAdapter',
    ],
    'versioned pipeline request',
  );
  if (typeof input.runId !== 'string' || !UUID.test(input.runId)) {
    throw new TypeError('Invalid evaluation run ID');
  }
  if (typeof input.isHistoricalReplay !== 'boolean') {
    throw new TypeError('Invalid historical replay flag');
  }
  if (!Array.isArray(input.items) || input.items.length > MAX_BATCH_SIZE) {
    throw new TypeError('Invalid versioned pipeline items');
  }
  if (
    !input.persistenceAdapter ||
    typeof input.persistenceAdapter.persistEvaluationBatch !== 'function'
  ) {
    throw new TypeError('A versioned persistence adapter is required');
  }

  const effectiveConfiguration = resolveEffectiveConfiguration(
    input.accountKey,
    input.configurationRevision,
  );
  const prepared = input.items.map((item) => {
    exactObject(item, ['message', 'makeCurrent'], 'versioned pipeline item');
    if (typeof item.makeCurrent !== 'boolean') {
      throw new TypeError('Current-effective selection must be explicit');
    }
    if (input.isHistoricalReplay && item.makeCurrent) {
      throw new TypeError('Historical replay cannot select a current-effective evaluation');
    }

    let normalized;
    let classification;
    let tagging;
    let policy;
    try {
      normalized = normalizeGmailMessage(item.message);
      if (typeof normalized.id !== 'string' || !normalized.id.trim()) {
        throw new TypeError('Versioned evaluation requires a valid message ID');
      }
      classification = classifyEmail(normalized);
      if (!['matched', 'insufficient_evidence'].includes(classification.status)) {
        throw new TypeError('Message classification is not valid for versioned evaluation');
      }
      tagging = validateTaggingResult(assignBuiltInTags(classification), {
        accountKey: effectiveConfiguration.accountKey,
        definitions: tagDefinitionsForConfiguration(effectiveConfiguration),
      });
      policy = evaluateNotificationPolicyV2({
        schemaVersion: '1.0',
        classification: publicClassification(classification),
        effectiveTags: tagging,
        effectiveConfiguration,
      });
      if (!['decided', 'insufficient_evidence'].includes(policy.status)) {
        throw new TypeError('Versioned policy evaluation did not produce a valid decision');
      }
    } catch (error) {
      throw new VersionedMessageProcessingError(
        error instanceof Error ? error.message : 'Versioned message processing failed',
      );
    }

    return {
      gmailMessageId: normalized.id,
      receivedAt: normalized.receivedAt,
      classification: publicClassification(classification),
      effectiveTags: tagging,
      policy,
      makeCurrent: item.makeCurrent,
    };
  });

  const persistence = await input.persistenceAdapter.persistEvaluationBatch({
    runId: input.runId,
    accountKey: effectiveConfiguration.accountKey,
    effectiveConfiguration,
    isHistoricalReplay: input.isHistoricalReplay,
    items: prepared.map(
      ({ gmailMessageId, receivedAt, classification, effectiveTags, makeCurrent }) => ({
        gmailMessageId,
        receivedAt,
        classification,
        effectiveTags,
        makeCurrent,
      }),
    ),
  });
  if (
    !persistence ||
    persistence.count !== prepared.length ||
    !Array.isArray(persistence.evaluations) ||
    persistence.evaluations.length !== prepared.length
  ) {
    throw new Error('Persisted evaluation results do not match the requested batch');
  }

  const persistedByMessage = new Map(
    persistence.evaluations.map((evaluation) => [evaluation.messageId, evaluation.evaluationId]),
  );
  if (persistedByMessage.size !== prepared.length) {
    throw new Error('Persisted evaluation results contain duplicate messages');
  }
  const results = prepared.map((item, index) => {
    const evaluationId = persistedByMessage.get(item.gmailMessageId);
    if (typeof evaluationId !== 'string') {
      throw new Error('Persisted evaluation is missing a message result');
    }
    return {
      messageNumber: index + 1,
      evaluationId,
      classification: item.classification,
      tagging: item.effectiveTags,
      policy: item.policy,
    };
  });

  return {
    schemaVersion: '2.0',
    runId: input.runId,
    isHistoricalReplay: input.isHistoricalReplay,
    configuration: {
      builtInDefaultsVersion: effectiveConfiguration.builtInDefaultsVersion,
      configurationRevision: effectiveConfiguration.configurationRevision,
      digest: effectiveConfiguration.digest,
    },
    results,
    persistence: {
      runId: persistence.runId,
      alreadyProcessed: persistence.alreadyProcessed,
      count: persistence.count,
    },
  };
}

module.exports = { processVersionedBatch, VersionedMessageProcessingError };

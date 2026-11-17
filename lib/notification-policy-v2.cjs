'use strict';

const {
  BUILT_IN_CATEGORY_DEFAULTS,
  validateEffectiveConfiguration,
} = require('./effective-configuration.cjs');
const { validateTaggingResult } = require('./tagging.cjs');
const { POLICY_CATEGORIES } = require('./notification-policy.cjs');

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function decision(category, policy, explanationCode, status) {
  const notificationCadence = policy?.notificationCadence ?? 'none';
  return {
    schemaVersion: '2.0',
    category,
    priority: policy?.priority ?? 'unset',
    notificationEligible: policy?.notificationEligible ?? false,
    notificationCadence,
    recommendedAction: policy?.recommendedAction ?? 'none',
    action: policy?.action ?? 'none',
    explanationCodes: [explanationCode],
    status,
  };
}

function failure(explanationCode, status) {
  return decision('other', null, explanationCode, status);
}

function validateClassification(classification) {
  if (!isPlainObject(classification)) {
    return { error: ['invalid_classification', 'invalid_classification'] };
  }
  if (typeof classification.schemaVersion !== 'string') {
    return { error: ['invalid_classification_schema', 'invalid_classification'] };
  }
  if (classification.schemaVersion !== '1.0') {
    return {
      error: ['unsupported_classification_schema', 'unsupported_classification'],
    };
  }
  if (classification.status === 'unsupported_schema') {
    return { error: ['unsupported_classification', 'unsupported_classification'] };
  }
  if (classification.status === 'insufficient_evidence') {
    if (classification.category !== 'other') {
      return { error: ['inconsistent_classification', 'invalid_classification'] };
    }
    return { insufficientEvidence: true };
  }
  if (classification.status !== 'matched') {
    return { error: ['invalid_classification_status', 'invalid_classification'] };
  }
  if (
    typeof classification.category !== 'string' ||
    !POLICY_CATEGORIES.includes(classification.category) ||
    classification.category === 'other'
  ) {
    return { error: ['invalid_classification_category', 'invalid_classification'] };
  }
  return { category: classification.category };
}

function evaluateNotificationPolicyV2(input) {
  if (
    !isPlainObject(input) ||
    Object.keys(input).length !== 4 ||
    !['schemaVersion', 'classification', 'effectiveTags', 'effectiveConfiguration'].every((key) =>
      Object.hasOwn(input, key),
    ) ||
    input.schemaVersion !== '1.0'
  ) {
    return failure('invalid_policy_input', 'invalid_input');
  }

  let configuration;
  try {
    configuration = validateEffectiveConfiguration(input.effectiveConfiguration);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return failure('invalid_effective_configuration', 'invalid_configuration');
  }

  try {
    validateTaggingResult(input.effectiveTags, {
      accountKey: configuration.accountKey,
      definitions: configuration.tagDefinitions,
    });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return failure('invalid_effective_tags', 'invalid_tagging');
  }

  const classification = validateClassification(input.classification);
  if (classification.error) {
    return failure(classification.error[0], classification.error[1]);
  }
  if (classification.insufficientEvidence) {
    return failure('insufficient_evidence', 'insufficient_evidence');
  }

  const category = classification.category;
  const policy = configuration.categories[category];
  const defaults = BUILT_IN_CATEGORY_DEFAULTS[category];
  const hasOverride = Object.keys(defaults).some((field) => policy[field] !== defaults[field]);
  return decision(
    category,
    policy,
    hasOverride ? 'category_override_applied' : 'default_policy_selected',
    'decided',
  );
}

module.exports = { evaluateNotificationPolicyV2 };

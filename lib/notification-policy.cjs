'use strict';

const DEFAULT_ACTIONS = Object.freeze({
  application_rejection: 'daily',
  interview_request: 'immediate',
  screening_request: 'immediate',
  application_confirmation: 'daily',
  application_update: 'daily',
  job_alert: 'weekly',
  recruiter_contact: 'immediate',
});

const CATEGORIES = new Set([...Object.keys(DEFAULT_ACTIONS), 'other']);
const ACTIONS = new Set(['immediate', 'daily', 'weekly', 'none']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validatedOverrides(config) {
  if (config === undefined) return {};
  if (!isPlainObject(config) || Object.keys(config).some((key) => key !== 'overrides')) return null;
  if (!Object.hasOwn(config, 'overrides')) return {};

  const overrides = config.overrides;
  if (!isPlainObject(overrides)) return null;
  for (const [category, action] of Object.entries(overrides)) {
    if (!CATEGORIES.has(category) || !ACTIONS.has(action)) return null;
  }
  return overrides;
}

function decision(category, action, explanationCodes, status) {
  return {
    schemaVersion: '1.0',
    category,
    action,
    explanationCodes,
    status,
  };
}

function evaluateNotificationPolicy(classification, config) {
  const overrides = validatedOverrides(config);
  if (overrides === null) {
    return decision('other', 'none', ['invalid_policy_configuration'], 'invalid_configuration');
  }
  if (!isPlainObject(classification)) {
    return decision('other', 'none', ['invalid_classification'], 'invalid_classification');
  }
  if (typeof classification.schemaVersion !== 'string') {
    return decision('other', 'none', ['invalid_classification_schema'], 'invalid_classification');
  }
  if (classification.schemaVersion !== '1.0') {
    return decision('other', 'none', ['unsupported_classification_schema'], 'unsupported_classification');
  }
  if (classification.status === 'unsupported_schema') {
    return decision('other', 'none', ['unsupported_classification'], 'unsupported_classification');
  }
  if (classification.status === 'insufficient_evidence') {
    if (classification.category !== 'other') {
      return decision('other', 'none', ['inconsistent_classification'], 'invalid_classification');
    }
    return decision('other', 'none', ['insufficient_evidence'], 'insufficient_evidence');
  }
  if (classification.status !== 'matched') {
    return decision('other', 'none', ['invalid_classification_status'], 'invalid_classification');
  }

  const { category } = classification;
  if (typeof category !== 'string' || !CATEGORIES.has(category) || category === 'other') {
    return decision('other', 'none', ['invalid_classification_category'], 'invalid_classification');
  }

  if (Object.hasOwn(overrides, category)) {
    return decision(category, overrides[category], ['category_override_applied'], 'decided');
  }
  return decision(category, DEFAULT_ACTIONS[category], ['default_action_selected'], 'decided');
}

module.exports = { evaluateNotificationPolicy };

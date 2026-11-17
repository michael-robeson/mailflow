'use strict';

const { createHash } = require('node:crypto');
const { validateTagDefinition } = require('./tagging.cjs');
const { POLICY_CATEGORIES } = require('./notification-policy.cjs');

const BUILT_IN_DEFAULTS_VERSION = 'mailflow-m1.1';
const ACCOUNT_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const PRIORITIES = new Set(['high', 'normal', 'low']);
const CADENCES = new Set(['immediate', 'daily', 'weekly']);
const RECOMMENDED_ACTIONS = new Set(['review', 'respond', 'reference', 'none']);
const CATEGORY_DEFAULTS = Object.freeze({
  application_rejection: Object.freeze({
    priority: 'normal',
    notificationEligible: true,
    notificationCadence: 'daily',
    recommendedAction: 'review',
    action: 'daily',
  }),
  interview_request: Object.freeze({
    priority: 'high',
    notificationEligible: true,
    notificationCadence: 'immediate',
    recommendedAction: 'respond',
    action: 'immediate',
  }),
  screening_request: Object.freeze({
    priority: 'high',
    notificationEligible: true,
    notificationCadence: 'immediate',
    recommendedAction: 'respond',
    action: 'immediate',
  }),
  application_confirmation: Object.freeze({
    priority: 'low',
    notificationEligible: true,
    notificationCadence: 'daily',
    recommendedAction: 'reference',
    action: 'daily',
  }),
  application_update: Object.freeze({
    priority: 'normal',
    notificationEligible: true,
    notificationCadence: 'daily',
    recommendedAction: 'review',
    action: 'daily',
  }),
  job_alert: Object.freeze({
    priority: 'low',
    notificationEligible: true,
    notificationCadence: 'weekly',
    recommendedAction: 'reference',
    action: 'weekly',
  }),
  recruiter_contact: Object.freeze({
    priority: 'normal',
    notificationEligible: true,
    notificationCadence: 'immediate',
    recommendedAction: 'respond',
    action: 'immediate',
  }),
  other: Object.freeze({
    priority: 'unset',
    notificationEligible: false,
    notificationCadence: null,
    recommendedAction: 'none',
    action: 'none',
  }),
});

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value, keys, label) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function accountKey(value) {
  if (typeof value !== 'string' || !ACCOUNT_KEY.test(value)) {
    throw new TypeError('Invalid account key');
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')}`;
}

function supportedCategory(category) {
  return typeof category === 'string' && POLICY_CATEGORIES.includes(category);
}

function normalizePolicyOverride(category, input) {
  if (!supportedCategory(category) || category === 'other') {
    throw new TypeError('Invalid policy override category');
  }
  if (!isPlainObject(input) || Object.keys(input).length === 0) {
    throw new TypeError('Invalid policy override');
  }
  const allowed = ['priority', 'notificationEligible', 'notificationCadence', 'recommendedAction'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new TypeError('Invalid policy override field');
  }
  const normalized = {};
  if (Object.hasOwn(input, 'priority')) {
    if (!PRIORITIES.has(input.priority)) throw new TypeError('Invalid policy override priority');
    normalized.priority = input.priority;
  }
  if (Object.hasOwn(input, 'notificationEligible')) {
    if (typeof input.notificationEligible !== 'boolean') {
      throw new TypeError('Invalid notification eligibility override');
    }
    normalized.notificationEligible = input.notificationEligible;
  }
  if (Object.hasOwn(input, 'notificationCadence')) {
    if (input.notificationCadence !== null && !CADENCES.has(input.notificationCadence)) {
      throw new TypeError('Invalid notification cadence override');
    }
    normalized.notificationCadence = input.notificationCadence;
  }
  if (Object.hasOwn(input, 'recommendedAction')) {
    if (!RECOMMENDED_ACTIONS.has(input.recommendedAction)) {
      throw new TypeError('Invalid recommended action override');
    }
    normalized.recommendedAction = input.recommendedAction;
  }
  return normalized;
}

function normalizeSnapshot(input, key) {
  object(input, ['policyOverrides', 'tagDefinitions'], 'configuration snapshot');
  if (!isPlainObject(input.policyOverrides)) {
    throw new TypeError('Invalid policy overrides');
  }
  if (!Array.isArray(input.tagDefinitions) || input.tagDefinitions.length > 100) {
    throw new TypeError('Invalid configuration tag definitions');
  }

  const policyOverrides = {};
  for (const category of Object.keys(input.policyOverrides).sort()) {
    policyOverrides[category] = normalizePolicyOverride(category, input.policyOverrides[category]);
  }

  const seen = new Set();
  const tagDefinitions = input.tagDefinitions
    .map((rawDefinition) => {
      const definition = validateTagDefinition(rawDefinition);
      if (
        definition.owner.type !== 'account' ||
        definition.owner.accountKey !== key ||
        definition.provenance !== 'user_defined'
      ) {
        throw new TypeError('Configuration tags must be user-defined and account-owned');
      }
      if (seen.has(definition.tagId)) throw new TypeError('Duplicate configuration tag ID');
      seen.add(definition.tagId);
      return definition;
    })
    .sort((left, right) => left.tagId.localeCompare(right.tagId));

  return { policyOverrides, tagDefinitions };
}

function configurationSnapshotDigest(rawAccountKey, snapshot) {
  const key = accountKey(rawAccountKey);
  const normalized = normalizeSnapshot(snapshot, key);
  return digest({ schemaVersion: '1.0', accountKey: key, snapshot: normalized });
}

function validateConfigurationRevision(input) {
  object(
    input,
    ['schemaVersion', 'revisionId', 'version', 'accountKey', 'createdAt', 'snapshot', 'digest'],
    'configuration revision',
  );
  if (input.schemaVersion !== '1.0') {
    throw new TypeError('Unsupported configuration revision schema');
  }
  if (!Number.isSafeInteger(input.revisionId) || input.revisionId < 1) {
    throw new TypeError('Invalid configuration revision ID');
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new TypeError('Invalid configuration version');
  }
  const key = accountKey(input.accountKey);
  if (
    typeof input.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    new Date(input.createdAt).toISOString() !== input.createdAt
  ) {
    throw new TypeError('Invalid configuration revision timestamp');
  }
  const snapshot = normalizeSnapshot(input.snapshot, key);
  const expectedDigest = digest({
    schemaVersion: '1.0',
    accountKey: key,
    snapshot,
  });
  if (input.digest !== expectedDigest) {
    throw new TypeError('Configuration revision digest mismatch');
  }
  return {
    schemaVersion: '1.0',
    revisionId: input.revisionId,
    version: input.version,
    accountKey: key,
    createdAt: input.createdAt,
    snapshot,
    digest: expectedDigest,
  };
}

function resolveEffectiveConfiguration(rawAccountKey, rawRevision = null) {
  const key = accountKey(rawAccountKey);
  const revision = rawRevision === null ? null : validateConfigurationRevision(rawRevision);
  if (revision && revision.accountKey !== key) {
    throw new TypeError('Configuration revision belongs to a different account');
  }

  const overrides = revision?.snapshot.policyOverrides ?? {};
  const categories = {};
  for (const category of POLICY_CATEGORIES) {
    const defaults = CATEGORY_DEFAULTS[category];
    if (!defaults) throw new Error(`Missing built-in policy defaults for ${category}`);
    const effective = { ...defaults, ...(overrides[category] ?? {}) };
    if (effective.notificationEligible !== (effective.notificationCadence !== null)) {
      throw new TypeError(`Inconsistent notification settings for ${category}`);
    }
    if (effective.notificationEligible) {
      if (!CADENCES.has(effective.notificationCadence)) {
        throw new TypeError(`Invalid notification cadence for ${category}`);
      }
      effective.action = effective.notificationCadence;
    } else {
      effective.action = 'none';
    }
    categories[category] = effective;
  }

  const tagDefinitions = revision?.snapshot.tagDefinitions ?? [];
  const configurationRevision = revision
    ? { revisionId: revision.revisionId, version: revision.version, digest: revision.digest }
    : null;
  const effective = {
    schemaVersion: '1.0',
    accountKey: key,
    builtInDefaultsVersion: BUILT_IN_DEFAULTS_VERSION,
    configurationRevision,
    categories,
    tagDefinitions,
  };
  return { ...effective, digest: digest(effective) };
}

module.exports = {
  BUILT_IN_DEFAULTS_VERSION,
  BUILT_IN_CATEGORY_DEFAULTS: CATEGORY_DEFAULTS,
  configurationSnapshotDigest,
  validateConfigurationRevision,
  resolveEffectiveConfiguration,
};

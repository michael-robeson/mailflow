'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BUILT_IN_DEFAULTS_VERSION,
  configurationSnapshotDigest,
  resolveEffectiveConfiguration,
  validateConfigurationRevision,
} = require('../lib/effective-configuration.cjs');
const { evaluateNotificationPolicy, POLICY_CATEGORIES } = require('../lib/notification-policy.cjs');
const packageApi = require('../lib');

const accountKey = 'synthetic_account';
const createdAt = '2026-11-17T17:00:00.000Z';

function snapshot(overrides = {}) {
  return { policyOverrides: overrides, tagDefinitions: [] };
}

function revision(configurationSnapshot = snapshot()) {
  return {
    schemaVersion: '1.0',
    revisionId: 42,
    version: 3,
    accountKey,
    createdAt,
    snapshot: configurationSnapshot,
    digest: configurationSnapshotDigest(accountKey, configurationSnapshot),
  };
}

test('resolves category defaults while preserving every version 1 notification action', () => {
  const effective = resolveEffectiveConfiguration(accountKey);
  assert.equal(effective.builtInDefaultsVersion, BUILT_IN_DEFAULTS_VERSION);
  assert.deepEqual(Object.keys(effective.categories).sort(), [...POLICY_CATEGORIES].sort());

  for (const category of POLICY_CATEGORIES) {
    const defaults = effective.categories[category];
    const classification = {
      schemaVersion: '1.0',
      category,
      status: category === 'other' ? 'insufficient_evidence' : 'matched',
    };
    const legacy = evaluateNotificationPolicy(classification);
    assert.equal(defaults.action, legacy.action, category);
    assert.equal(defaults.notificationEligible, legacy.action !== 'none', category);
    assert.equal(
      defaults.notificationCadence,
      legacy.action === 'none' ? null : legacy.action,
      category,
    );
    if (category === 'other') {
      assert.equal(defaults.priority, 'unset');
      assert.equal(defaults.recommendedAction, 'none');
    } else {
      assert.ok(['high', 'normal', 'low'].includes(defaults.priority));
    }
  }
});

test('priority, notification cadence, and workflow action override independently', () => {
  const effective = resolveEffectiveConfiguration(
    accountKey,
    revision(
      snapshot({
        job_alert: { priority: 'high', recommendedAction: 'review' },
        interview_request: { notificationCadence: 'weekly' },
      }),
    ),
  );
  assert.deepEqual(
    {
      priority: effective.categories.job_alert.priority,
      notificationEligible: effective.categories.job_alert.notificationEligible,
      notificationCadence: effective.categories.job_alert.notificationCadence,
      recommendedAction: effective.categories.job_alert.recommendedAction,
      action: effective.categories.job_alert.action,
    },
    {
      priority: 'high',
      notificationEligible: true,
      notificationCadence: 'weekly',
      recommendedAction: 'review',
      action: 'weekly',
    },
  );
  assert.equal(effective.categories.interview_request.priority, 'high');
  assert.equal(effective.categories.interview_request.notificationCadence, 'weekly');
  assert.equal(effective.categories.interview_request.action, 'weekly');
});

test('configuration revisions retain account-scoped snapshots and stable digests', () => {
  const tagA = {
    schemaVersion: '1.0',
    tagId: 'follow_up',
    name: 'Follow up',
    owner: { type: 'account', accountKey },
    provenance: 'user_defined',
  };
  const tagB = {
    schemaVersion: '1.0',
    tagId: 'reference',
    name: 'Reference',
    owner: { type: 'account', accountKey },
    provenance: 'user_defined',
  };
  const first = snapshot({
    job_alert: { priority: 'normal', recommendedAction: 'reference' },
    interview_request: { notificationCadence: 'weekly' },
  });
  first.tagDefinitions = [tagA, tagB];
  const reordered = {
    tagDefinitions: [tagB, tagA],
    policyOverrides: {
      interview_request: { notificationCadence: 'weekly' },
      job_alert: { recommendedAction: 'reference', priority: 'normal' },
    },
  };

  assert.equal(
    configurationSnapshotDigest(accountKey, first),
    configurationSnapshotDigest(accountKey, reordered),
  );
  const validated = validateConfigurationRevision(revision(first));
  assert.deepEqual(
    validated.snapshot.tagDefinitions.map(({ tagId }) => tagId),
    ['follow_up', 'reference'],
  );
  assert.equal(validated.digest, configurationSnapshotDigest(accountKey, first));
  assert.deepEqual(first.tagDefinitions, [tagA, tagB]);
});

test('rejects malformed, cross-account, or tampered configuration revisions', () => {
  const valid = revision();
  for (const invalid of [
    { ...valid, revisionId: 0 },
    { ...valid, version: 0 },
    { ...valid, createdAt: '2026-02-30T00:00:00.000Z' },
    { ...valid, digest: 'sha256:bad' },
    {
      ...valid,
      snapshot: snapshot({ unknown_category: { priority: 'high' } }),
    },
    {
      ...valid,
      snapshot: snapshot({ job_alert: { priority: 'unset' } }),
    },
    {
      ...valid,
      snapshot: snapshot({ job_alert: { notificationEligible: false } }),
    },
    {
      ...valid,
      snapshot: snapshot({ job_alert: { notificationCadence: null } }),
    },
    {
      ...valid,
      snapshot: {
        ...snapshot(),
        tagDefinitions: [
          {
            schemaVersion: '1.0',
            tagId: 'interview_request',
            name: 'Custom interview request',
            owner: { type: 'account', accountKey },
            provenance: 'user_defined',
          },
        ],
      },
    },
  ]) {
    assert.throws(() => validateConfigurationRevision(invalid), TypeError);
  }

  assert.throws(() => resolveEffectiveConfiguration('another_account', valid), /different account/);
  assert.throws(
    () =>
      revision({
        policyOverrides: {},
        tagDefinitions: [
          {
            schemaVersion: '1.0',
            tagId: 'foreign',
            name: 'Foreign',
            owner: { type: 'account', accountKey: 'another_account' },
            provenance: 'user_defined',
          },
        ],
      }),
    /account-owned/,
  );
});

test('keeps insufficient-evidence defaults fail-closed and exposes additive package APIs', () => {
  const effective = resolveEffectiveConfiguration(accountKey);
  assert.deepEqual(effective.categories.other, {
    priority: 'unset',
    notificationEligible: false,
    notificationCadence: null,
    recommendedAction: 'none',
    action: 'none',
  });
  assert.equal(typeof packageApi.validateTagDefinition, 'function');
  assert.equal(typeof packageApi.resolveEffectiveConfiguration, 'function');
});

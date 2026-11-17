'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BUILT_IN_CATEGORY_DEFAULTS,
  configurationSnapshotDigest,
  resolveEffectiveConfiguration,
} = require('../lib/effective-configuration.cjs');
const { evaluateNotificationPolicyV2 } = require('../lib/notification-policy-v2.cjs');
const { evaluateNotificationPolicy, POLICY_CATEGORIES } = require('../lib/notification-policy.cjs');
const packageApi = require('../lib');

const accountKey = 'policy_test_account';
const createdAt = '2026-11-17T17:00:00.000Z';

function accountRevision(policyOverrides = {}, tagDefinitions = []) {
  const snapshot = { policyOverrides, tagDefinitions };
  return {
    schemaVersion: '1.0',
    revisionId: 7,
    version: 2,
    accountKey,
    createdAt,
    snapshot,
    digest: configurationSnapshotDigest(accountKey, snapshot),
  };
}

function classification(category, status = 'matched', overrides = {}) {
  return {
    schemaVersion: '1.0',
    category,
    status,
    ...overrides,
  };
}

function input(category, options = {}) {
  return {
    schemaVersion: '1.0',
    classification: options.classification ?? classification(category, options.status ?? 'matched'),
    effectiveTags: options.effectiveTags ?? { schemaVersion: '1.0', assignments: [] },
    effectiveConfiguration:
      options.effectiveConfiguration ??
      resolveEffectiveConfiguration(accountKey, options.revision ?? null),
  };
}

test('v2 defaults match category configuration and preserve the v1 action contract', () => {
  for (const category of POLICY_CATEGORIES) {
    const status = category === 'other' ? 'insufficient_evidence' : 'matched';
    const result = evaluateNotificationPolicyV2(input(category, { status }));
    const defaults = BUILT_IN_CATEGORY_DEFAULTS[category];
    const legacy = evaluateNotificationPolicy(classification(category, status));

    assert.deepEqual(result, {
      schemaVersion: '2.0',
      category,
      priority: defaults.priority,
      notificationEligible: defaults.notificationEligible,
      notificationCadence: defaults.notificationCadence ?? 'none',
      recommendedAction: defaults.recommendedAction,
      action: defaults.action,
      explanationCodes: [
        category === 'other' ? 'insufficient_evidence' : 'default_policy_selected',
      ],
      status: status === 'insufficient_evidence' ? status : 'decided',
    });
    assert.equal(result.action, legacy.action);
  }

  assert.deepEqual(Object.keys(evaluateNotificationPolicy(classification('interview_request'))), [
    'schemaVersion',
    'category',
    'action',
    'explanationCodes',
    'status',
  ]);
  assert.equal(typeof packageApi.evaluateNotificationPolicyV2, 'function');
});

test('account overrides independently control priority, cadence, eligibility, and action', () => {
  const revision = accountRevision({
    interview_request: {
      priority: 'low',
      notificationEligible: false,
      notificationCadence: null,
      recommendedAction: 'respond',
    },
    job_alert: {
      priority: 'high',
      notificationCadence: 'daily',
      recommendedAction: 'review',
    },
  });
  const interview = evaluateNotificationPolicyV2(input('interview_request', { revision }));
  const alert = evaluateNotificationPolicyV2(input('job_alert', { revision }));

  assert.deepEqual(
    {
      priority: interview.priority,
      notificationEligible: interview.notificationEligible,
      notificationCadence: interview.notificationCadence,
      recommendedAction: interview.recommendedAction,
      action: interview.action,
    },
    {
      priority: 'low',
      notificationEligible: false,
      notificationCadence: 'none',
      recommendedAction: 'respond',
      action: 'none',
    },
  );
  assert.equal(alert.priority, 'high');
  assert.equal(alert.notificationEligible, true);
  assert.equal(alert.notificationCadence, 'daily');
  assert.equal(alert.recommendedAction, 'review');
  assert.equal(alert.action, 'daily');
  assert.equal(interview.status, 'decided');
  assert.ok(!('delivered' in interview));
  assert.ok(!('scheduledAt' in interview));
});

test('effective tags are validated but do not change category-based policy', () => {
  const definition = {
    schemaVersion: '1.0',
    tagId: 'follow_up',
    name: 'Follow up',
    owner: { type: 'account', accountKey },
    provenance: 'user_defined',
  };
  const revision = accountRevision({}, [definition]);
  const withoutTag = evaluateNotificationPolicyV2(input('job_alert', { revision }));
  const withTag = evaluateNotificationPolicyV2(
    input('job_alert', {
      revision,
      effectiveTags: {
        schemaVersion: '1.0',
        assignments: [
          {
            schemaVersion: '1.0',
            tagId: 'follow_up',
            provenance: { type: 'user_correction', correctionId: 'correction_1' },
          },
        ],
      },
    }),
  );

  assert.deepEqual(withTag, withoutTag);
});

test('insufficient evidence fails closed regardless of configured category policies', () => {
  const result = evaluateNotificationPolicyV2(
    input('other', {
      status: 'insufficient_evidence',
      revision: accountRevision({
        interview_request: { priority: 'low', recommendedAction: 'review' },
      }),
    }),
  );

  assert.deepEqual(result, {
    schemaVersion: '2.0',
    category: 'other',
    priority: 'unset',
    notificationEligible: false,
    notificationCadence: 'none',
    recommendedAction: 'none',
    action: 'none',
    explanationCodes: ['insufficient_evidence'],
    status: 'insufficient_evidence',
  });
});

test('invalid inputs, configurations, classifications, and tags fail closed', () => {
  const base = input('interview_request');
  const invalidConfiguration = structuredClone(base.effectiveConfiguration);
  invalidConfiguration.categories.interview_request.priority = 'unset';

  const cases = [
    [null, 'invalid_policy_input', 'invalid_input'],
    [{ ...base, schemaVersion: '2.0' }, 'invalid_policy_input', 'invalid_input'],
    [
      { ...base, classification: { category: 'interview_request', status: 'matched' } },
      'invalid_classification_schema',
      'invalid_classification',
    ],
    [
      { ...base, classification: classification('interview_request', 'unsupported_schema') },
      'unsupported_classification',
      'unsupported_classification',
    ],
    [
      {
        ...base,
        classification: classification('interview_request', 'insufficient_evidence'),
      },
      'inconsistent_classification',
      'invalid_classification',
    ],
    [
      { ...base, classification: classification('future_category') },
      'invalid_classification_category',
      'invalid_classification',
    ],
    [
      { ...base, effectiveConfiguration: invalidConfiguration },
      'invalid_effective_configuration',
      'invalid_configuration',
    ],
    [
      {
        ...base,
        effectiveTags: {
          schemaVersion: '1.0',
          assignments: [
            {
              schemaVersion: '1.0',
              tagId: 'not_defined',
              provenance: {
                type: 'user_correction',
                correctionId: 'correction_1',
              },
            },
          ],
        },
      },
      'invalid_effective_tags',
      'invalid_tagging',
    ],
  ];

  for (const [candidate, explanationCode, status] of cases) {
    const result = evaluateNotificationPolicyV2(candidate);
    assert.equal(result.category, 'other');
    assert.equal(result.priority, 'unset');
    assert.equal(result.notificationEligible, false);
    assert.equal(result.notificationCadence, 'none');
    assert.equal(result.recommendedAction, 'none');
    assert.equal(result.action, 'none');
    assert.deepEqual(result.explanationCodes, [explanationCode]);
    assert.equal(result.status, status);
  }
});

test('evaluation does not mutate classifications, tags, or resolved configuration', () => {
  const definition = {
    schemaVersion: '1.0',
    tagId: 'follow_up',
    name: 'Follow up',
    owner: { type: 'account', accountKey },
    provenance: 'user_defined',
  };
  const candidate = input('application_update', {
    revision: accountRevision({ application_update: { priority: 'high' } }, [definition]),
    effectiveTags: {
      schemaVersion: '1.0',
      assignments: [
        {
          schemaVersion: '1.0',
          tagId: 'follow_up',
          provenance: { type: 'user_correction', correctionId: 'correction_2' },
        },
      ],
    },
  });
  const snapshot = structuredClone(candidate);

  evaluateNotificationPolicyV2(candidate);

  assert.deepEqual(candidate, snapshot);
});

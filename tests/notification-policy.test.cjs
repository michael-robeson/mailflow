'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateNotificationPolicy } = require('../lib/notification-policy.cjs');

const defaults = [
  ['application_rejection', 'daily'],
  ['interview_request', 'immediate'],
  ['screening_request', 'immediate'],
  ['application_confirmation', 'daily'],
  ['application_update', 'daily'],
  ['job_alert', 'weekly'],
  ['recruiter_contact', 'immediate'],
];

function classification(category, overrides = {}) {
  return { schemaVersion: '1.0', category, status: 'matched', ...overrides };
}

for (const [category, action] of defaults) {
  test(`selects the documented default for ${category}`, () => {
    assert.deepEqual(evaluateNotificationPolicy(classification(category)), {
      schemaVersion: '1.0',
      category,
      action,
      explanationCodes: ['default_action_selected'],
      status: 'decided',
    });
  });
}

test('applies per-category overrides without mutating configuration or classification', () => {
  const input = classification('application_confirmation', {
    messageId: 'synthetic-id',
    matchedRuleIds: ['application_received'],
  });
  const config = { overrides: { application_confirmation: 'daily' } };
  const inputSnapshot = structuredClone(input);
  const configSnapshot = structuredClone(config);

  assert.deepEqual(evaluateNotificationPolicy(input, config), {
    schemaVersion: '1.0',
    category: 'application_confirmation',
    action: 'daily',
    explanationCodes: ['category_override_applied'],
    status: 'decided',
  });
  assert.deepEqual(input, inputSnapshot);
  assert.deepEqual(config, configSnapshot);
});

test('supports each action value as an independent category override', () => {
  const overrides = {
    application_rejection: 'none',
    interview_request: 'weekly',
    screening_request: 'daily',
    application_confirmation: 'immediate',
  };

  for (const [category, action] of Object.entries(overrides)) {
    assert.equal(
      evaluateNotificationPolicy(classification(category), { overrides }).action,
      action,
    );
  }
});

test('allows overriding other while insufficient evidence always remains none', () => {
  const result = evaluateNotificationPolicy({
    schemaVersion: '1.0',
    category: 'other',
    status: 'insufficient_evidence',
    body: 'Synthetic sensitive message content',
    messageId: 'synthetic-id',
  }, { overrides: { other: 'immediate' } });

  assert.deepEqual(result, {
    schemaVersion: '1.0',
    category: 'other',
    action: 'none',
    explanationCodes: ['insufficient_evidence'],
    status: 'insufficient_evidence',
  });
  assert.ok(!JSON.stringify(result).includes('Synthetic sensitive message content'));
  assert.ok(!JSON.stringify(result).includes('synthetic-id'));
});

test('invalid configurations fail closed and report the configuration error', () => {
  const invalidConfigs = [
    null,
    [],
    'invalid',
    { unknown: true },
    { overrides: null },
    { overrides: [] },
    { overrides: { unknown_category: 'daily' } },
    { overrides: { job_alert: 'sometimes' } },
  ];

  for (const config of invalidConfigs) {
    assert.deepEqual(evaluateNotificationPolicy(classification('interview_request'), config), {
      schemaVersion: '1.0',
      category: 'other',
      action: 'none',
      explanationCodes: ['invalid_policy_configuration'],
      status: 'invalid_configuration',
    });
  }
});

test('malformed, unsupported, or ambiguous classifications fail closed', () => {
  const cases = [
    [null, 'invalid_classification', 'invalid_classification'],
    [[], 'invalid_classification', 'invalid_classification'],
    [{ category: 'interview_request', status: 'matched' }, 'invalid_classification_schema', 'invalid_classification'],
    [classification('interview_request', { schemaVersion: '2.0' }), 'unsupported_classification_schema', 'unsupported_classification'],
    [{ schemaVersion: '1.0', category: 'other', status: 'unsupported_schema' }, 'unsupported_classification', 'unsupported_classification'],
    [{ schemaVersion: '1.0', category: 'interview_request', status: 'insufficient_evidence' }, 'inconsistent_classification', 'invalid_classification'],
    [{ schemaVersion: '1.0', category: 'future_category', status: 'matched' }, 'invalid_classification_category', 'invalid_classification'],
    [{ schemaVersion: '1.0', category: 'other', status: 'matched' }, 'invalid_classification_category', 'invalid_classification'],
    [{ schemaVersion: '1.0', category: 'interview_request', status: 'invalid_input' }, 'invalid_classification_status', 'invalid_classification'],
  ];

  for (const [input, explanationCode, status] of cases) {
    assert.deepEqual(evaluateNotificationPolicy(input), {
      schemaVersion: '1.0',
      category: 'other',
      action: 'none',
      explanationCodes: [explanationCode],
      status,
    });
  }
});

test('uses the classifier-resolved category for overlapping intents', () => {
  const result = evaluateNotificationPolicy(classification('interview_request', {
    matchedRuleIds: ['interview_invitation', 'application_received'],
  }));
  assert.equal(result.category, 'interview_request');
  assert.equal(result.action, 'immediate');
});

test('decision output contains no identifiers, message text, or classification details', () => {
  const result = evaluateNotificationPolicy(classification('job_alert', {
    messageId: 'synthetic-private-id',
    subject: 'Synthetic private subject',
    body: 'Synthetic private body',
    matchedRuleIds: ['job_alert_digest'],
  }));
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('synthetic-private-id'));
  assert.ok(!serialized.includes('Synthetic private'));
  assert.ok(!serialized.includes('job_alert_digest'));
  assert.deepEqual(Object.keys(result), [
    'schemaVersion', 'category', 'action', 'explanationCodes', 'status',
  ]);
  assert.ok(!('delivered' in result));
  assert.ok(!('scheduledAt' in result));
});

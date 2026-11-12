'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyEmail } = require('../lib/email-classify.cjs');
const { normalizeGmailMessage } = require('../lib/gmail-normalize.cjs');

function message(overrides = {}) {
  return {
    schemaVersion: '1.0', id: 'synthetic-id', threadId: 'synthetic-thread',
    sender: { name: null, address: null }, subject: null, receivedAt: null,
    body: '', warnings: [], ...overrides,
  };
}

const examples = [
  ['application_rejection', 'rejection_application_outcome', 'We will not move forward with your application.'],
  ['interview_request', 'interview_invitation', 'We would like to schedule an interview.'],
  ['screening_request', 'screening_invitation', 'Please schedule a phone screening call.'],
  ['application_confirmation', 'application_received', "We've received your application."],
  ['application_update', 'application_status_update', 'Your application is under review.'],
  ['job_alert', 'job_alert_digest', 'New jobs matching your preferences.'],
  ['recruiter_contact', 'recruiter_direct_outreach', "I'm a recruiter and wanted to introduce myself."],
];

for (const [category, rule, body] of examples) {
  test(`classifies ${category} using explainable rule identifiers`, () => {
    assert.deepEqual(classifyEmail(message({ body })), {
      schemaVersion: '1.0',
      messageId: 'synthetic-id',
      category,
      matchedRuleIds: [rule],
      explanationCodes: ['positive_rule_matched'],
      status: 'matched',
    });
  });
}

test('handles overlapping positive matches using documented precedence', () => {
  const result = classifyEmail(message({
    sender: { name: 'Example Recruiter', address: 'team@example.test' },
    subject: 'Interview invitation',
    body: "I'm a recruiter. Please schedule a phone screening call. We received your application.",
  }));
  assert.equal(result.category, 'interview_request');
  assert.deepEqual(result.matchedRuleIds, [
    'interview_invitation', 'screening_invitation', 'application_received', 'recruiter_direct_outreach',
  ]);
  assert.deepEqual(result.explanationCodes, ['positive_rule_matched', 'precedence_applied']);
});

test('rejection takes precedence over earlier stage requests', () => {
  const result = classifyEmail(message({
    subject: 'Interview invitation',
    body: 'We will not move forward with your application.',
  }));
  assert.equal(result.category, 'application_rejection');
  assert.deepEqual(result.matchedRuleIds, ['rejection_application_outcome', 'interview_invitation']);
});

test('recognizes recruiter sender only alongside job-related text', () => {
  const sender = { name: 'Example Recruiter', address: 'team@example.test' };
  assert.equal(classifyEmail(message({ sender, subject: 'A new position for you' })).category, 'recruiter_contact');
  assert.equal(classifyEmail(message({ sender, subject: 'A friendly greeting' })).status, 'insufficient_evidence');
  assert.equal(classifyEmail(message({ sender, subject: 'There is no job opportunity' })).status, 'insufficient_evidence');
  assert.equal(classifyEmail(message({ sender, subject: 'The job opportunity was cancelled' })).status, 'insufficient_evidence');
});

test('does not classify generic keywords, negated invitations, or unrelated alerts as positive evidence', () => {
  const examples = [
    'The interview is a topic in this article.',
    'We do not invite you to an interview.',
    'You are not invited to a phone screening.',
    'Interview invitation is not confirmed.',
    'Interview invitation has been cancelled.',
    'Interview tips and career advice.',
    'A security alert for your account.',
    'Your application is a useful tool.',
    'Your application is not available.',
    'The job market has changed.',
  ];
  for (const body of examples) {
    const result = classifyEmail(message({ body }));
    assert.equal(result.category, 'other', body);
    assert.equal(result.status, 'insufficient_evidence', body);
    assert.deepEqual(result.matchedRuleIds, []);
  }
});

test('recognizes subject-only and case-insensitive signals', () => {
  assert.equal(classifyEmail(message({ subject: 'APPLICATION RECEIVED' })).category, 'application_confirmation');
  assert.equal(classifyEmail(message({ subject: 'Interview scheduling' })).category, 'interview_request');
  assert.equal(classifyEmail(message({ subject: 'Weekly job alert' })).category, 'job_alert');
});

test('missing fields are safe and message IDs are preserved without inventing evidence', () => {
  assert.deepEqual(classifyEmail({ schemaVersion: '1.0' }), {
    schemaVersion: '1.0', messageId: null, category: 'other', matchedRuleIds: [],
    explanationCodes: ['no_positive_rule', 'missing_message_id'], status: 'insufficient_evidence',
  });
  const result = classifyEmail(message({ id: null, subject: 'Application received' }));
  assert.equal(result.category, 'application_confirmation');
  assert.equal(result.messageId, null);
  assert.deepEqual(result.explanationCodes, ['positive_rule_matched', 'missing_message_id']);
  const unchanged = ' id-with-spaces ';
  assert.equal(classifyEmail(message({ id: unchanged })).messageId, unchanged);
});

test('rejects malformed inputs and unsupported schemas without classifying', () => {
  for (const input of [null, [], 'invalid']) {
    assert.equal(classifyEmail(input).status, 'invalid_input');
    assert.deepEqual(classifyEmail(input).explanationCodes, ['invalid_message']);
  }
  for (const version of [undefined, '2.0', 1]) {
    const result = classifyEmail(message({ schemaVersion: version, body: 'Application received' }));
    assert.equal(result.status, 'unsupported_schema');
    assert.equal(result.category, 'other');
    assert.deepEqual(result.explanationCodes, ['unsupported_schema_version']);
  }
  for (const overrides of [
    { id: 12 }, { subject: [] }, { body: {} }, { sender: 'bad' },
    { sender: { name: 7 } }, { sender: { address: [] } },
  ]) {
    const result = classifyEmail(message(overrides));
    assert.equal(result.status, 'invalid_input');
    assert.deepEqual(result.explanationCodes, ['invalid_field_type']);
  }
});

test('normalizer output flows through classifier without exposing content or mutating input', () => {
  const sensitive = 'Synthetic private marker: schedule an interview';
  const normalized = normalizeGmailMessage({
    id: 'synthetic-id', payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'From', value: 'Example Recruiter <team@example.test>' }],
      body: { data: Buffer.from(sensitive).toString('base64url') },
    },
  });
  const snapshot = structuredClone(normalized);
  const result = classifyEmail(normalized);
  assert.equal(result.category, 'interview_request');
  assert.deepEqual(normalized, snapshot);
  assert.ok(!JSON.stringify(result).includes(sensitive));
  assert.ok(!JSON.stringify(result).includes('team@example.test'));
});

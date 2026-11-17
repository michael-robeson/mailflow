'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BUILT_IN_TAG_DEFINITIONS,
  assignBuiltInTags,
  tagDefinitionsForConfiguration,
  validateTagAssignment,
  validateTagDefinition,
  validateTaggingResult,
} = require('../lib/tagging.cjs');

const accountKey = 'synthetic_account';

function builtInTag(overrides = {}) {
  return {
    schemaVersion: '1.0',
    tagId: 'newsletter',
    name: 'Newsletter',
    owner: { type: 'system' },
    provenance: 'built_in',
    ...overrides,
  };
}

function userTag(overrides = {}) {
  return {
    schemaVersion: '1.0',
    tagId: 'follow_up',
    name: 'Follow up',
    owner: { type: 'account', accountKey },
    provenance: 'user_defined',
    ...overrides,
  };
}

function assignment(tagId, provenance) {
  return { schemaVersion: '1.0', tagId, provenance };
}

test('validates built-in and account-owned tag definitions', () => {
  assert.deepEqual(validateTagDefinition(builtInTag()), builtInTag());
  assert.deepEqual(validateTagDefinition(userTag()), userTag());
});

test('assigns deterministic category tags with existing classifier-rule provenance', () => {
  const classification = {
    schemaVersion: '1.0',
    category: 'interview_request',
    status: 'matched',
    matchedRuleIds: ['interview_invitation', 'recruiter_direct_outreach'],
  };
  const assignments = assignBuiltInTags(classification);

  assert.deepEqual(assignments, {
    schemaVersion: '1.0',
    assignments: [
      {
        schemaVersion: '1.0',
        tagId: 'interview_request',
        provenance: { type: 'built_in_rule', ruleId: 'interview_invitation' },
      },
    ],
  });
  assert.equal(BUILT_IN_TAG_DEFINITIONS.length, 7);
  assert.deepEqual(
    validateTaggingResult(assignments, {
      accountKey,
      definitions: tagDefinitionsForConfiguration({ tagDefinitions: [userTag()] }),
    }),
    assignments,
  );
  assert.deepEqual(
    assignBuiltInTags({
      schemaVersion: '1.0',
      category: 'other',
      status: 'insufficient_evidence',
      matchedRuleIds: [],
    }),
    { schemaVersion: '1.0', assignments: [] },
  );
  assert.throws(
    () =>
      assignBuiltInTags({
        ...classification,
        matchedRuleIds: ['recruiter_direct_outreach'],
      }),
    TypeError,
  );
});

test('rejects invalid tag definition schemas, ownership, provenance, and fields', () => {
  const invalid = [
    { ...builtInTag(), schemaVersion: '2.0' },
    { ...builtInTag(), tagId: 'Invalid-Tag' },
    { ...builtInTag(), name: '  ' },
    { ...builtInTag(), owner: { type: 'system', accountKey } },
    { ...builtInTag(), provenance: 'user_defined' },
    { ...userTag(), provenance: 'built_in' },
    { ...userTag(), unexpected: true },
  ];
  for (const definition of invalid) {
    assert.throws(() => validateTagDefinition(definition), TypeError);
  }
});

test('validates tag assignments against definitions and account ownership', () => {
  const input = {
    schemaVersion: '1.0',
    assignments: [
      assignment('newsletter', { type: 'built_in_rule', ruleId: 'newsletter_signal' }),
      assignment('follow_up', { type: 'user_correction', correctionId: 'correction_1' }),
    ],
  };
  const definitions = [builtInTag(), userTag()];
  const snapshot = structuredClone(input);

  assert.deepEqual(validateTaggingResult(input, { accountKey, definitions }), input);
  assert.deepEqual(input, snapshot);
});

test('rejects dangling, duplicate, cross-account, and invalid-provenance assignments', () => {
  const context = { accountKey, definitions: [builtInTag(), userTag()] };
  const empty = { schemaVersion: '1.0', assignments: [] };
  const cases = [
    {
      input: {
        schemaVersion: '1.0',
        assignments: [
          assignment('missing', { type: 'user_correction', correctionId: 'correction_1' }),
        ],
      },
      context,
    },
    {
      input: {
        schemaVersion: '1.0',
        assignments: [assignment('follow_up', { type: 'built_in_rule', ruleId: 'rule_1' })],
      },
      context,
    },
    {
      input: {
        schemaVersion: '1.0',
        assignments: [
          assignment('newsletter', { type: 'built_in_rule', ruleId: 'rule_1' }),
          assignment('newsletter', { type: 'built_in_rule', ruleId: 'rule_2' }),
        ],
      },
      context,
    },
    {
      input: empty,
      context: {
        accountKey,
        definitions: [userTag({ owner: { type: 'account', accountKey: 'other_account' } })],
      },
    },
    {
      input: {
        schemaVersion: '1.0',
        assignments: [assignment('newsletter', { type: 'built_in_rule', ruleId: 'bad rule id' })],
      },
      context,
    },
  ];
  for (const { input, context: testContext } of cases) {
    assert.throws(() => validateTaggingResult(input, testContext), TypeError);
  }
});

test('rejects malformed tagging results and contexts', () => {
  assert.throws(
    () =>
      validateTaggingResult(
        { schemaVersion: '2.0', assignments: [] },
        {
          accountKey,
          definitions: [],
        },
      ),
    TypeError,
  );
  assert.throws(
    () =>
      validateTagAssignment({
        schemaVersion: '1.0',
        tagId: 'follow_up',
        provenance: { type: 'user_correction', correctionId: 'bad id' },
      }),
    TypeError,
  );
  assert.throws(
    () =>
      validateTaggingResult(
        { schemaVersion: '1.0', assignments: [] },
        {
          accountKey,
          definitions: [builtInTag(), builtInTag()],
        },
      ),
    /Duplicate tag definition/,
  );
});

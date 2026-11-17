'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveEffectiveConfiguration } = require('../lib/effective-configuration.cjs');
const { createVersionedPersistenceAdapter } = require('../lib/versioned-persistence.cjs');

const accountKey = 'synthetic_account';
const runId = '40000000-0000-4000-8000-000000000001';
const correctionId = '40000000-0000-4000-8000-000000000002';

function fakePool() {
  let connectCount = 0;
  return {
    connect: async () => {
      connectCount++;
      throw new Error('Unexpected database connection');
    },
    query: async () => {
      throw new Error('Unexpected pool query');
    },
    get connectCount() {
      return connectCount;
    },
  };
}

function validBatch(overrides = {}) {
  return {
    runId,
    accountKey,
    effectiveConfiguration: resolveEffectiveConfiguration(accountKey),
    isHistoricalReplay: false,
    items: [
      {
        gmailMessageId: 'synthetic_message',
        receivedAt: '2026-01-01T00:00:00Z',
        classification: {
          schemaVersion: '1.0',
          category: 'job_alert',
          status: 'matched',
          matchedRuleIds: ['job_alert_digest'],
          explanationCodes: ['positive_rule_matched'],
        },
        effectiveTags: { schemaVersion: '1.0', assignments: [] },
        makeCurrent: true,
        ...overrides.item,
      },
    ],
    ...overrides.batch,
  };
}

test('versioned persistence rejects invalid revision snapshots before connecting', async () => {
  const pool = fakePool();
  const adapter = createVersionedPersistenceAdapter(pool);
  await assert.rejects(
    adapter.persistConfigurationRevision({
      requestId: correctionId,
      accountKey,
      snapshot: { policyOverrides: { unknown_category: { priority: 'high' } }, tagDefinitions: [] },
    }),
    TypeError,
  );
  assert.equal(pool.connectCount, 0);
});

test('evaluation persistence validates account scope, current selection, and replay bounds offline', async () => {
  const pool = fakePool();
  const adapter = createVersionedPersistenceAdapter(pool);
  const valid = validBatch();
  const wrongAccount = {
    ...valid,
    accountKey: 'another_account',
  };
  const noCurrentChoice = validBatch({ item: { makeCurrent: undefined } });
  delete noCurrentChoice.items[0].makeCurrent;
  const historicalMakesCurrent = validBatch({
    batch: { isHistoricalReplay: true },
  });
  const unknownTag = validBatch({
    item: {
      effectiveTags: {
        schemaVersion: '1.0',
        assignments: [
          {
            schemaVersion: '1.0',
            tagId: 'missing_tag',
            provenance: {
              type: 'user_correction',
              correctionId,
            },
          },
        ],
      },
    },
  });

  for (const batch of [wrongAccount, noCurrentChoice, historicalMakesCurrent, unknownTag]) {
    await assert.rejects(adapter.persistEvaluationBatch(batch), TypeError);
  }
  assert.equal(pool.connectCount, 0);
});

test('tag correction input is constrained to account-scoped append-only tag operations', async () => {
  const pool = fakePool();
  const adapter = createVersionedPersistenceAdapter(pool);
  await assert.rejects(
    adapter.persistTagCorrection({
      schemaVersion: '1.0',
      correctionId,
      accountKey,
      messageId: 'synthetic_message',
      baseEvaluationId: '1',
      target: { type: 'tag', operation: 'replace', tagId: 'follow_up' },
      source: 'user',
    }),
    TypeError,
  );
  assert.equal(pool.connectCount, 0);
});

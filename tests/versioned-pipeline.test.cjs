'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { configurationSnapshotDigest } = require('../lib/effective-configuration.cjs');
const { processVersionedBatch } = require('../lib/versioned-pipeline.cjs');
const packageApi = require('../lib');

const accountKey = 'versioned_pipeline_account';
const runId = '60000000-0000-4000-8000-000000000001';
const revision = {
  schemaVersion: '1.0',
  revisionId: 3,
  version: 2,
  accountKey,
  createdAt: '2026-11-17T17:00:00.000Z',
  snapshot: {
    policyOverrides: {
      interview_request: { priority: 'normal', recommendedAction: 'review' },
    },
    tagDefinitions: [
      {
        schemaVersion: '1.0',
        tagId: 'follow_up',
        name: 'Follow up',
        owner: { type: 'account', accountKey },
        provenance: 'user_defined',
      },
    ],
  },
  digest: '',
};
revision.digest = configurationSnapshotDigest(accountKey, revision.snapshot);

function message(id, body) {
  return {
    id,
    internalDate: '1794934800000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Recruiter <recruiter@example.test>' },
        { name: 'Subject', value: '' },
      ],
      body: { data: Buffer.from(body, 'utf8').toString('base64url') },
    },
  };
}

function idempotentPersistence() {
  const batches = new Map();
  const calls = [];
  return {
    calls,
    async persistEvaluationBatch(batch) {
      calls.push(batch);
      const serialized = JSON.stringify(batch);
      const existing = batches.get(batch.runId);
      if (existing) {
        if (existing.serialized !== serialized) {
          throw new Error('Evaluation run ID already exists with different input');
        }
        return { ...existing.result, alreadyProcessed: true };
      }
      const result = {
        runId: batch.runId,
        alreadyProcessed: false,
        count: batch.items.length,
        evaluations: batch.items.map((item, index) => ({
          evaluationId: String(index + 1),
          messageId: item.gmailMessageId,
        })),
      };
      batches.set(batch.runId, { serialized, result });
      return result;
    },
  };
}

function request(persistenceAdapter, overrides = {}) {
  return {
    runId,
    accountKey,
    configurationRevision: revision,
    isHistoricalReplay: false,
    items: [
      {
        message: message('synthetic_pipeline_message', 'We would like to interview you'),
        makeCurrent: true,
      },
    ],
    persistenceAdapter,
    ...overrides,
  };
}

test('opt-in pipeline resolves configuration, tags, evaluates v2 policy, and persists once', async () => {
  const persistenceAdapter = idempotentPersistence();
  const first = await processVersionedBatch(request(persistenceAdapter));
  const retry = await processVersionedBatch(request(persistenceAdapter));

  assert.equal(typeof packageApi.processVersionedBatch, 'function');
  assert.equal(first.schemaVersion, '2.0');
  assert.deepEqual(first.configuration.configurationRevision, {
    revisionId: 3,
    version: 2,
    digest: revision.digest,
  });
  assert.equal(first.results[0].messageNumber, 1);
  assert.equal(first.results[0].classification.category, 'interview_request');
  assert.deepEqual(first.results[0].tagging.assignments, [
    {
      schemaVersion: '1.0',
      tagId: 'interview_request',
      provenance: { type: 'built_in_rule', ruleId: 'interview_invitation' },
    },
  ]);
  assert.equal(first.results[0].policy.priority, 'normal');
  assert.equal(first.results[0].policy.recommendedAction, 'review');
  assert.equal(first.results[0].policy.notificationCadence, 'immediate');
  assert.equal(first.persistence.alreadyProcessed, false);
  assert.equal(retry.persistence.alreadyProcessed, true);
  assert.equal(retry.results[0].evaluationId, first.results[0].evaluationId);
  assert.equal(persistenceAdapter.calls.length, 2);
  assert.equal(JSON.stringify(first).includes('synthetic_pipeline_message'), false);
});

test('insufficient evidence is tagged empty and stays fail-closed', async () => {
  const persistenceAdapter = idempotentPersistence();
  const result = await processVersionedBatch(
    request(persistenceAdapter, {
      items: [{ message: message('synthetic_no_evidence', 'Hello there'), makeCurrent: true }],
    }),
  );

  assert.deepEqual(result.results[0].tagging, { schemaVersion: '1.0', assignments: [] });
  assert.equal(result.results[0].policy.priority, 'unset');
  assert.equal(result.results[0].policy.action, 'none');
  assert.equal(result.results[0].policy.status, 'insufficient_evidence');
});

test('invalid configuration and implicit historical selection fail before persistence', async () => {
  const persistenceAdapter = idempotentPersistence();
  const wrongAccountRevision = {
    ...revision,
    accountKey: 'another_account',
    snapshot: {
      ...revision.snapshot,
      tagDefinitions: revision.snapshot.tagDefinitions.map((definition) => ({
        ...definition,
        owner: { type: 'account', accountKey: 'another_account' },
      })),
    },
  };
  wrongAccountRevision.digest = configurationSnapshotDigest(
    'another_account',
    wrongAccountRevision.snapshot,
  );

  await assert.rejects(
    processVersionedBatch(
      request(persistenceAdapter, { configurationRevision: wrongAccountRevision }),
    ),
    /different account/,
  );
  await assert.rejects(
    processVersionedBatch(request(persistenceAdapter, { isHistoricalReplay: true })),
    /cannot select a current-effective evaluation/,
  );
  assert.equal(persistenceAdapter.calls.length, 0);
});

test('explicit historical runs remain non-current and malformed messages are not persisted', async () => {
  const persistenceAdapter = idempotentPersistence();
  const result = await processVersionedBatch(
    request(persistenceAdapter, {
      isHistoricalReplay: true,
      items: [
        {
          message: message('synthetic_replay_message', 'We would like to interview you'),
          makeCurrent: false,
        },
      ],
    }),
  );

  assert.equal(result.isHistoricalReplay, true);
  assert.equal(persistenceAdapter.calls[0].items[0].makeCurrent, false);
  await assert.rejects(
    processVersionedBatch(
      request(persistenceAdapter, {
        items: [{ message: message('', 'We would like to interview you'), makeCurrent: true }],
      }),
    ),
    /valid message ID/,
  );
  assert.equal(persistenceAdapter.calls.length, 1);
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Pool } = require('pg');
const { createPersistenceAdapter } = require('../../lib/persistence.cjs');
const {
  configurationSnapshotDigest,
  resolveEffectiveConfiguration,
} = require('../../lib/effective-configuration.cjs');
const { createVersionedPersistenceAdapter } = require('../../lib/versioned-persistence.cjs');
const { processVersionedBatch } = require('../../lib/versioned-pipeline.cjs');

const pool = new Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'postgres',
  user: 'mailflow_test_app',
});
const adapter = createVersionedPersistenceAdapter(pool);
const legacyAdapter = createPersistenceAdapter(pool);
const accountKey = 'synthetic_m1_persistence';
const revisionRequestId = '50000000-0000-4000-8000-000000000001';
const run1 = '50000000-0000-4000-8000-000000000002';
const run2 = '50000000-0000-4000-8000-000000000003';
const correction1 = '50000000-0000-4000-8000-000000000004';
const correction2 = '50000000-0000-4000-8000-000000000005';
const legacyRun1 = '50000000-0000-4000-8000-000000000006';
const legacyRun2 = '50000000-0000-4000-8000-000000000007';
const invalidLegacyRun = '50000000-0000-4000-8000-000000000008';
const rollbackRun = '50000000-0000-4000-8000-000000000009';
const legacyCurrentConflictRun = '50000000-0000-4000-8000-000000000011';
const unpersistedRevisionRun = '50000000-0000-4000-8000-000000000012';
const versionedPipelineRun = '50000000-0000-4000-8000-000000000013';
const versionedReplayRun = '50000000-0000-4000-8000-000000000014';

const followUpDefinition = {
  schemaVersion: '1.0',
  tagId: 'follow_up',
  name: 'Follow up',
  owner: { type: 'account', accountKey },
  provenance: 'user_defined',
};
const archiveDefinition = {
  schemaVersion: '1.0',
  tagId: 'archive',
  name: 'Archive',
  owner: { type: 'account', accountKey },
  provenance: 'user_defined',
};
const configurationSnapshot = {
  policyOverrides: {
    job_alert: { priority: 'high', recommendedAction: 'review' },
  },
  tagDefinitions: [followUpDefinition, archiveDefinition],
};

function gmailMessage(id, body) {
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

function evaluationBatch(runId, revision, overrides = {}) {
  return {
    runId,
    accountKey,
    effectiveConfiguration: resolveEffectiveConfiguration(accountKey, revision),
    isHistoricalReplay: false,
    items: [
      {
        gmailMessageId: 'synthetic_m1_message',
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
        ...overrides,
      },
    ],
  };
}

function legacyBatch(runId, messageId, category, status, action, policyStatus) {
  return {
    runId,
    accountKey,
    items: [
      {
        gmailMessageId: messageId,
        receivedAt: '2026-01-01T00:00:00Z',
        classification: {
          category,
          status,
          matchedRuleIds: status === 'matched' ? ['job_alert_digest'] : [],
          explanationCodes: ['synthetic_test'],
        },
        policy: {
          action,
          status: policyStatus,
          explanationCodes: ['synthetic_test'],
        },
      },
    ],
  };
}

test('isolated PostgreSQL persists immutable M1 history, corrections, current selection, and safe fallback', async (t) => {
  t.after(() => pool.end());

  const created = await adapter.persistConfigurationRevision({
    requestId: revisionRequestId,
    accountKey,
    snapshot: configurationSnapshot,
  });
  assert.equal(created.alreadyProcessed, false);
  assert.equal(created.revision.version, 1);
  assert.equal(
    created.revision.digest,
    configurationSnapshotDigest(accountKey, configurationSnapshot),
  );
  assert.deepEqual(
    created.revision.snapshot.tagDefinitions.map(({ tagId }) => tagId),
    ['archive', 'follow_up'],
  );
  const retriedRevision = await adapter.persistConfigurationRevision({
    requestId: revisionRequestId,
    accountKey,
    snapshot: configurationSnapshot,
  });
  assert.equal(retriedRevision.alreadyProcessed, true);
  assert.equal(retriedRevision.revision.revisionId, created.revision.revisionId);
  await assert.rejects(
    adapter.persistConfigurationRevision({
      requestId: revisionRequestId,
      accountKey,
      snapshot: { ...configurationSnapshot, policyOverrides: {} },
    }),
    /different input/,
  );
  const nextRevision = await adapter.persistConfigurationRevision({
    requestId: '50000000-0000-4000-8000-000000000010',
    accountKey,
    snapshot: configurationSnapshot,
  });
  assert.equal(nextRevision.revision.version, 2);
  const unpersistedRevision = {
    ...created.revision,
    revisionId: created.revision.revisionId + 100,
  };
  await assert.rejects(
    adapter.persistEvaluationBatch(evaluationBatch(unpersistedRevisionRun, unpersistedRevision)),
    /not persisted/,
  );
  const unpersistedBatch = await pool.query(
    'SELECT count(*)::int AS count FROM mailflow.versioned_evaluation_batches WHERE id = $1',
    [unpersistedRevisionRun],
  );
  assert.equal(unpersistedBatch.rows[0].count, 0);

  const firstBatch = evaluationBatch(run1, created.revision);
  const firstWrites = await Promise.all([
    adapter.persistEvaluationBatch(firstBatch),
    adapter.persistEvaluationBatch(firstBatch),
  ]);
  assert.deepEqual(firstWrites.map((result) => result.alreadyProcessed).sort(), [false, true]);
  assert.equal(
    firstWrites[0].evaluations[0].evaluationId,
    firstWrites[1].evaluations[0].evaluationId,
  );
  const firstEvaluationId = firstWrites[0].evaluations[0].evaluationId;
  assert.equal(firstWrites[0].evaluations[0].messageId, 'synthetic_m1_message');
  await assert.rejects(
    adapter.persistEvaluationBatch(evaluationBatch(run1, created.revision, { makeCurrent: false })),
    /different input/,
  );

  const addCorrection = {
    schemaVersion: '1.0',
    correctionId: correction1,
    accountKey,
    messageId: 'synthetic_m1_message',
    baseEvaluationId: firstEvaluationId,
    target: { type: 'tag', operation: 'add', tagId: 'follow_up' },
    source: 'user',
  };
  assert.equal((await adapter.persistTagCorrection(addCorrection)).alreadyProcessed, false);
  assert.equal((await adapter.persistTagCorrection(addCorrection)).alreadyProcessed, true);
  await assert.rejects(
    adapter.persistTagCorrection({
      ...addCorrection,
      target: { ...addCorrection.target, operation: 'remove' },
    }),
    /different input/,
  );
  let effectiveTags = await adapter.resolveEffectiveTags({
    accountKey,
    evaluationId: firstEvaluationId,
  });
  assert.deepEqual(effectiveTags.assignments, [
    {
      schemaVersion: '1.0',
      tagId: 'follow_up',
      provenance: { type: 'user_correction', correctionId: correction1 },
    },
  ]);

  const replay = evaluationBatch(run2, created.revision, {
    gmailMessageId: 'synthetic_m1_message',
    classification: {
      schemaVersion: '1.0',
      category: 'application_update',
      status: 'matched',
      matchedRuleIds: ['application_status_update'],
      explanationCodes: ['positive_rule_matched'],
    },
    makeCurrent: false,
  });
  replay.isHistoricalReplay = true;
  const replayResult = await adapter.persistEvaluationBatch(replay);
  assert.equal(replayResult.alreadyProcessed, false);
  let current = await adapter.getCurrentEffectiveEvaluation({
    accountKey,
    messageId: 'synthetic_m1_message',
  });
  assert.equal(current.source, 'current_effective');
  assert.equal(current.evaluation.evaluationId, firstEvaluationId);
  assert.equal(current.evaluation.policy.priority, 'high');
  assert.equal(current.evaluation.policy.notificationCadence, 'weekly');
  assert.equal(current.evaluation.configuration.accountRevisionVersion, 1);
  assert.equal(current.evaluation.tagging.assignments[0].tagId, 'follow_up');

  const removeCorrection = {
    ...addCorrection,
    correctionId: correction2,
    target: { type: 'tag', operation: 'remove', tagId: 'follow_up' },
  };
  await adapter.persistTagCorrection(removeCorrection);
  effectiveTags = await adapter.resolveEffectiveTags({
    accountKey,
    evaluationId: firstEvaluationId,
  });
  assert.deepEqual(effectiveTags.assignments, []);

  const secondEvaluationId = replayResult.evaluations[0].evaluationId;
  await adapter.selectCurrentEffectiveEvaluation({
    accountKey,
    messageId: 'synthetic_m1_message',
    evaluationId: secondEvaluationId,
  });
  current = await adapter.getCurrentEffectiveEvaluation({
    accountKey,
    messageId: 'synthetic_m1_message',
  });
  assert.equal(current.evaluation.evaluationId, secondEvaluationId);
  assert.deepEqual(current.evaluation.tagging.assignments, []);

  const pipelineRequest = {
    runId: versionedPipelineRun,
    accountKey,
    configurationRevision: created.revision,
    isHistoricalReplay: false,
    items: [
      {
        message: gmailMessage('synthetic_pipeline_interview', 'We would like to interview you'),
        makeCurrent: true,
      },
    ],
    persistenceAdapter: adapter,
  };
  const pipelineResult = await processVersionedBatch(pipelineRequest);
  const pipelineRetry = await processVersionedBatch(pipelineRequest);
  const pipelineEvaluationId = pipelineResult.results[0].evaluationId;
  assert.equal(pipelineResult.results[0].classification.category, 'interview_request');
  assert.deepEqual(pipelineResult.results[0].tagging.assignments, [
    {
      schemaVersion: '1.0',
      tagId: 'interview_request',
      provenance: { type: 'built_in_rule', ruleId: 'interview_invitation' },
    },
  ]);
  assert.equal(pipelineResult.results[0].policy.priority, 'high');
  assert.equal(pipelineResult.persistence.alreadyProcessed, false);
  assert.equal(pipelineRetry.persistence.alreadyProcessed, true);
  assert.equal(pipelineRetry.results[0].evaluationId, pipelineEvaluationId);
  const pipelineCurrent = await adapter.getCurrentEffectiveEvaluation({
    accountKey,
    messageId: 'synthetic_pipeline_interview',
  });
  assert.equal(pipelineCurrent.evaluation.evaluationId, pipelineEvaluationId);

  const removeBuiltInTag = {
    schemaVersion: '1.0',
    correctionId: '50000000-0000-4000-8000-000000000016',
    accountKey,
    messageId: 'synthetic_pipeline_interview',
    baseEvaluationId: pipelineEvaluationId,
    target: { type: 'tag', operation: 'remove', tagId: 'interview_request' },
    source: 'user',
  };
  const addUserTag = {
    ...removeBuiltInTag,
    correctionId: '50000000-0000-4000-8000-000000000017',
    target: { type: 'tag', operation: 'add', tagId: 'follow_up' },
  };
  await adapter.persistTagCorrection(removeBuiltInTag);
  await adapter.persistTagCorrection(addUserTag);
  const correctedPipelineCurrent = await adapter.getCurrentEffectiveEvaluation({
    accountKey,
    messageId: 'synthetic_pipeline_interview',
  });
  assert.deepEqual(correctedPipelineCurrent.evaluation.tagging.assignments, [
    {
      schemaVersion: '1.0',
      tagId: 'follow_up',
      provenance: { type: 'user_correction', correctionId: addUserTag.correctionId },
    },
  ]);

  const pipelineReplayResult = await processVersionedBatch({
    ...pipelineRequest,
    runId: versionedReplayRun,
    isHistoricalReplay: true,
    items: [
      {
        message: gmailMessage('synthetic_pipeline_interview', 'Your application was unsuccessful'),
        makeCurrent: false,
      },
    ],
  });
  assert.notEqual(pipelineReplayResult.results[0].evaluationId, pipelineEvaluationId);
  current = await adapter.getCurrentEffectiveEvaluation({
    accountKey,
    messageId: 'synthetic_pipeline_interview',
  });
  assert.equal(current.evaluation.evaluationId, pipelineEvaluationId);
  assert.deepEqual(
    current.evaluation.tagging.assignments,
    correctedPipelineCurrent.evaluation.tagging.assignments,
  );
  await adapter.selectCurrentEffectiveEvaluation({
    accountKey,
    messageId: 'synthetic_pipeline_interview',
    evaluationId: pipelineReplayResult.results[0].evaluationId,
  });
  current = await adapter.getCurrentEffectiveEvaluation({
    accountKey,
    messageId: 'synthetic_pipeline_interview',
  });
  assert.equal(current.evaluation.evaluationId, pipelineReplayResult.results[0].evaluationId);

  await legacyAdapter.persistBatch(
    legacyBatch(
      legacyCurrentConflictRun,
      'synthetic_m1_message',
      'job_alert',
      'matched',
      'weekly',
      'decided',
    ),
  );
  current = await adapter.getCurrentEffectiveEvaluation({
    accountKey,
    messageId: 'synthetic_m1_message',
  });
  assert.equal(current.source, 'current_effective');
  assert.equal(current.evaluation.evaluationId, secondEvaluationId);

  await legacyAdapter.persistBatch(
    legacyBatch(legacyRun1, 'synthetic_legacy_unique', 'job_alert', 'matched', 'weekly', 'decided'),
  );
  const fallback = await adapter.getCurrentEffectiveEvaluation({
    accountKey,
    messageId: 'synthetic_legacy_unique',
  });
  assert.equal(fallback.status, 'resolved');
  assert.equal(fallback.source, 'legacy_fallback');
  assert.equal(fallback.evaluation.configuration, null);
  assert.deepEqual(fallback.evaluation.tagging.assignments, []);

  await legacyAdapter.persistBatch(
    legacyBatch(
      legacyRun2,
      'synthetic_legacy_unique',
      'application_update',
      'matched',
      'daily',
      'decided',
    ),
  );
  const ambiguous = await adapter.getCurrentEffectiveEvaluation({
    accountKey,
    messageId: 'synthetic_legacy_unique',
  });
  assert.deepEqual(ambiguous, {
    status: 'unresolved',
    reason: 'ambiguous_legacy_evaluations',
  });

  await legacyAdapter.persistBatch(
    legacyBatch(
      invalidLegacyRun,
      'synthetic_legacy_invalid',
      'other',
      'matched',
      'none',
      'decided',
    ),
  );
  const invalidFallback = await adapter.getCurrentEffectiveEvaluation({
    accountKey,
    messageId: 'synthetic_legacy_invalid',
  });
  assert.equal(invalidFallback.status, 'unresolved');
  assert.equal(invalidFallback.reason, 'invalid_legacy_evaluation');

  const rollbackPool = {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      return {
        query(sql, params) {
          if (sql.includes('INSERT INTO mailflow.evaluation_tag_assignments')) {
            throw new Error('synthetic M1 assignment failure');
          }
          return client.query(sql, params);
        },
        release: (error) => client.release(error),
      };
    },
  };
  const failingAdapter = createVersionedPersistenceAdapter(rollbackPool);
  const rollbackRequest = {
    runId: rollbackRun,
    accountKey,
    configurationRevision: created.revision,
    isHistoricalReplay: false,
    items: [
      {
        message: gmailMessage('synthetic_m1_rollback', 'We would like to interview you'),
        makeCurrent: true,
      },
    ],
    persistenceAdapter: failingAdapter,
  };
  await assert.rejects(processVersionedBatch(rollbackRequest), /synthetic M1 assignment failure/);
  const rolledBack = await pool.query(
    `SELECT
      (SELECT count(*)::int FROM mailflow.versioned_evaluation_batches WHERE id = $1) AS batches,
      (SELECT count(*)::int FROM mailflow.evaluations WHERE batch_id = $1) AS evaluations,
      (SELECT count(*)::int FROM mailflow.messages WHERE account_key = $2 AND gmail_message_id = $3) AS messages,
      (SELECT count(*)::int FROM mailflow.current_effective_evaluations c JOIN mailflow.messages m ON m.id = c.message_id WHERE c.account_key = $2 AND m.gmail_message_id = $3) AS current_rows`,
    [rollbackRun, accountKey, 'synthetic_m1_rollback'],
  );
  assert.deepEqual(rolledBack.rows[0], {
    batches: 0,
    evaluations: 0,
    messages: 0,
    current_rows: 0,
  });
  const rollbackRetry = await processVersionedBatch({
    ...rollbackRequest,
    persistenceAdapter: adapter,
  });
  assert.equal(rollbackRetry.persistence.alreadyProcessed, false);
  const rollbackCurrent = await adapter.getCurrentEffectiveEvaluation({
    accountKey,
    messageId: 'synthetic_m1_rollback',
  });
  assert.equal(rollbackCurrent.evaluation.evaluationId, rollbackRetry.results[0].evaluationId);

  const immutable = await pool.query(
    `SELECT
      (SELECT count(*)::int FROM mailflow.account_configuration_revisions WHERE account_key = $1) AS revisions,
      (SELECT count(*)::int FROM mailflow.evaluations WHERE account_key = $1) AS evaluations,
      (SELECT count(*)::int FROM mailflow.evaluation_tag_assignments WHERE account_key = $1) AS assignments,
      (SELECT count(*)::int FROM mailflow.tag_corrections WHERE account_key = $1) AS corrections`,
    [accountKey],
  );
  assert.deepEqual(immutable.rows[0], {
    revisions: 2,
    evaluations: 5,
    assignments: 3,
    corrections: 4,
  });
  await assert.rejects(
    pool.query('UPDATE mailflow.account_configuration_revisions SET version = 99'),
    { code: '42501' },
  );
  await assert.rejects(pool.query('DELETE FROM mailflow.evaluations'), { code: '42501' });
});

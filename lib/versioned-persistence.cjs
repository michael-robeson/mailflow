'use strict';

const { createHash } = require('node:crypto');
const {
  configurationSnapshotDigest,
  normalizeConfigurationSnapshot,
  resolveEffectiveConfiguration,
  validateConfigurationRevision,
  validateEffectiveConfiguration,
} = require('./effective-configuration.cjs');
const { evaluateNotificationPolicyV2 } = require('./notification-policy-v2.cjs');
const {
  validateTagDefinition,
  validateTaggingResult,
  tagDefinitionsForConfiguration,
} = require('./tagging.cjs');
const { POLICY_CATEGORIES } = require('./notification-policy.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,256}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const TAG_ID = /^[a-z][a-z0-9_]{0,63}$/;
const EVALUATION_ID = /^[1-9][0-9]*$/;
const LEGACY_ACTIONS = new Set(['immediate', 'daily', 'weekly', 'none']);
const LEGACY_CLASSIFICATION_STATUSES = new Set([
  'matched',
  'insufficient_evidence',
  'invalid_input',
  'unsupported_schema',
]);
const LEGACY_POLICY_STATUSES = new Set([
  'decided',
  'insufficient_evidence',
  'invalid_configuration',
  'invalid_classification',
  'unsupported_classification',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value, requiredKeys, optionalKeys = [], label = 'object') {
  if (
    !isPlainObject(value) ||
    requiredKeys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function identifier(value, expression, label, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength || !expression.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function accountKey(value) {
  return identifier(value, ACCOUNT_KEY, 'account key', 128);
}

function uuid(value, label) {
  return identifier(value, UUID, label, 36).toLowerCase();
}

function codeArray(value, label) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value.map((entry) => identifier(entry, CODE, label, 64));
}

function isoTimestamp(value, label, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
  return new Date(value).toISOString();
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isoFromDatabase(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid database timestamp');
  return date.toISOString();
}

function revisionFromRow(row) {
  return validateConfigurationRevision({
    schemaVersion: '1.0',
    revisionId: Number(row.id),
    version: row.version,
    accountKey: row.account_key,
    createdAt: isoFromDatabase(row.created_at),
    snapshot: row.snapshot,
    digest: row.digest,
  });
}

function normalizeClassification(input, messageId) {
  object(
    input,
    ['schemaVersion', 'category', 'status', 'matchedRuleIds', 'explanationCodes'],
    ['messageId'],
    'classification',
  );
  if (input.schemaVersion !== '1.0') {
    throw new TypeError('Unsupported classification schema');
  }
  if (input.messageId !== undefined && input.messageId !== null) {
    if (typeof input.messageId !== 'string' || input.messageId !== messageId) {
      throw new TypeError('Classification message ID does not match the evaluation');
    }
  }
  return {
    schemaVersion: '1.0',
    category: identifier(input.category, CODE, 'classification category', 64),
    status: identifier(input.status, CODE, 'classification status', 64),
    matchedRuleIds: codeArray(input.matchedRuleIds, 'matched rule IDs'),
    explanationCodes: codeArray(input.explanationCodes, 'classification explanation codes'),
  };
}

function normalizeItem(input, account, configuration, isHistoricalReplay, seenMessageIds) {
  object(
    input,
    ['gmailMessageId', 'classification', 'effectiveTags', 'makeCurrent'],
    ['receivedAt'],
    'versioned evaluation item',
  );
  const gmailMessageId = identifier(input.gmailMessageId, IDENTIFIER, 'Gmail message ID', 256);
  if (seenMessageIds.has(gmailMessageId)) {
    throw new TypeError('Duplicate Gmail message ID');
  }
  seenMessageIds.add(gmailMessageId);
  if (typeof input.makeCurrent !== 'boolean') {
    throw new TypeError('Current-effective selection must be explicit');
  }
  if (isHistoricalReplay && input.makeCurrent) {
    throw new TypeError('Historical replay cannot select a current-effective evaluation');
  }
  const receivedAt = isoTimestamp(input.receivedAt, 'received timestamp', true);
  const classification = normalizeClassification(input.classification, gmailMessageId);
  const effectiveTags = validateTaggingResult(input.effectiveTags, {
    accountKey: account,
    definitions: tagDefinitionsForConfiguration(configuration),
  });
  const policy = evaluateNotificationPolicyV2({
    schemaVersion: '1.0',
    classification,
    effectiveTags,
    effectiveConfiguration: configuration,
  });
  if (policy.status === 'invalid_configuration' || policy.status === 'invalid_tagging') {
    throw new TypeError('Invalid effective policy inputs');
  }
  if (input.makeCurrent && !['decided', 'insufficient_evidence'].includes(policy.status)) {
    throw new TypeError('Invalid evaluation cannot become current');
  }
  return {
    gmailMessageId,
    receivedAt,
    classification,
    effectiveTags,
    policy,
    makeCurrent: input.makeCurrent,
  };
}

function normalizeEvaluationBatch(input) {
  object(
    input,
    ['runId', 'accountKey', 'effectiveConfiguration', 'isHistoricalReplay', 'items'],
    [],
    'versioned evaluation batch',
  );
  const runId = uuid(input.runId, 'evaluation run ID');
  const account = accountKey(input.accountKey);
  if (typeof input.isHistoricalReplay !== 'boolean') {
    throw new TypeError('Invalid historical replay flag');
  }
  const configuration = validateEffectiveConfiguration(input.effectiveConfiguration);
  if (configuration.accountKey !== account) {
    throw new TypeError('Effective configuration belongs to a different account');
  }
  if (!Array.isArray(input.items) || input.items.length > 25) {
    throw new TypeError('Invalid versioned evaluation items');
  }
  const seenMessageIds = new Set();
  const items = input.items.map((item) =>
    normalizeItem(item, account, configuration, input.isHistoricalReplay, seenMessageIds),
  );
  const normalized = {
    runId,
    accountKey: account,
    effectiveConfiguration: configuration,
    isHistoricalReplay: input.isHistoricalReplay,
    items,
  };
  const batchHash = hash({
    runId,
    accountKey: account,
    configurationDigest: configuration.digest,
    isHistoricalReplay: input.isHistoricalReplay,
    items,
  });
  return { ...normalized, batchHash };
}

function normalizeCorrection(input) {
  object(
    input,
    [
      'schemaVersion',
      'correctionId',
      'accountKey',
      'messageId',
      'baseEvaluationId',
      'target',
      'source',
    ],
    [],
    'tag correction',
  );
  if (input.schemaVersion !== '1.0' || input.source !== 'user') {
    throw new TypeError('Unsupported tag correction');
  }
  const correctionId = uuid(input.correctionId, 'correction ID');
  const account = accountKey(input.accountKey);
  const messageId = identifier(input.messageId, IDENTIFIER, 'Gmail message ID', 256);
  const baseEvaluationId = identifier(
    input.baseEvaluationId,
    EVALUATION_ID,
    'base evaluation ID',
    20,
  );
  object(input.target, ['type', 'operation', 'tagId'], [], 'tag correction target');
  if (
    input.target.type !== 'tag' ||
    !['add', 'remove'].includes(input.target.operation) ||
    typeof input.target.tagId !== 'string' ||
    !TAG_ID.test(input.target.tagId)
  ) {
    throw new TypeError('Invalid tag correction target');
  }
  return {
    schemaVersion: '1.0',
    correctionId,
    accountKey: account,
    messageId,
    baseEvaluationId,
    target: {
      type: 'tag',
      operation: input.target.operation,
      tagId: input.target.tagId,
    },
    source: 'user',
  };
}

async function transaction(pool, callback) {
  const client = await pool.connect();
  let active = false;
  let releaseError;
  try {
    await client.query('BEGIN');
    active = true;
    const result = await callback(client);
    await client.query('COMMIT');
    active = false;
    return result;
  } catch (error) {
    if (active) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = rollbackError;
        throw new AggregateError(
          [error, rollbackError],
          'Versioned persistence failed and rollback failed',
          { cause: rollbackError },
        );
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

async function readSnapshot(pool, callback) {
  const client = await pool.connect();
  let active = false;
  let releaseError;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    active = true;
    const result = await callback(client);
    await client.query('COMMIT');
    active = false;
    return result;
  } catch (error) {
    if (active) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = rollbackError;
        throw new AggregateError(
          [error, rollbackError],
          'Versioned read failed and rollback failed',
          { cause: rollbackError },
        );
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

function validLegacyClassification(row) {
  if (
    !POLICY_CATEGORIES.includes(row.category) ||
    !LEGACY_CLASSIFICATION_STATUSES.has(row.classification_status)
  ) {
    return false;
  }
  return row.classification_status === 'matched'
    ? row.category !== 'other'
    : row.category === 'other';
}

function validLegacyPolicy(row) {
  if (!LEGACY_ACTIONS.has(row.action) || !LEGACY_POLICY_STATUSES.has(row.policy_status)) {
    return false;
  }
  if (row.policy_status === 'invalid_configuration') return row.action === 'none';
  if (row.classification_status === 'matched') return row.policy_status === 'decided';
  if (row.classification_status === 'insufficient_evidence') {
    return row.policy_status === 'insufficient_evidence' && row.action === 'none';
  }
  if (row.classification_status === 'unsupported_schema') {
    return row.policy_status === 'unsupported_classification' && row.action === 'none';
  }
  return row.policy_status === 'invalid_classification' && row.action === 'none';
}

function validLegacyPair(row) {
  if (!row.policy_id || !validLegacyClassification(row) || !validLegacyPolicy(row)) {
    return null;
  }

  try {
    const classification = {
      schemaVersion: '1.0',
      category: row.category,
      status: row.classification_status,
      matchedRuleIds: codeArray(row.matched_rule_ids, 'matched rule IDs'),
      explanationCodes: codeArray(row.classification_explanation_codes, 'classification codes'),
    };
    const policy = {
      schemaVersion: '1.0',
      category: row.category,
      action: row.action,
      status: row.policy_status,
      explanationCodes: codeArray(row.policy_explanation_codes, 'policy codes'),
    };
    return { classification, policy };
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function configurationFromEvaluation(row) {
  if (row.configuration_revision_id === null) {
    return {
      builtInDefaultsVersion: row.built_in_defaults_version,
      accountRevisionId: null,
      accountRevisionVersion: null,
      accountRevisionDigest: null,
    };
  }
  return {
    builtInDefaultsVersion: row.built_in_defaults_version,
    accountRevisionId: Number(row.configuration_revision_id),
    accountRevisionVersion: row.configuration_version,
    accountRevisionDigest: row.configuration_digest,
  };
}

function assignmentsFromRows(rows) {
  return rows.map((row) => ({
    schemaVersion: '1.0',
    tagId: row.tag_id,
    provenance:
      row.provenance_type === 'built_in_rule'
        ? { type: 'built_in_rule', ruleId: row.provenance_reference }
        : { type: 'user_correction', correctionId: row.provenance_reference },
  }));
}

function definitionExists(snapshot, account, tagId) {
  const definitions = tagDefinitionsForConfiguration({
    tagDefinitions: snapshot?.tagDefinitions ?? [],
  });
  return definitions.some((rawDefinition) => {
    try {
      const definition = validateTagDefinition(rawDefinition);
      return (
        definition.tagId === tagId &&
        (definition.owner.type === 'system' ||
          (definition.owner.type === 'account' && definition.owner.accountKey === account))
      );
    } catch (error) {
      if (error instanceof TypeError) return false;
      throw error;
    }
  });
}

async function validatePersistedConfiguration(client, configuration) {
  const revisionReference = configuration.configurationRevision;
  let revision = null;
  if (revisionReference) {
    const stored = await client.query(
      `SELECT id, version, account_key, snapshot, digest, created_at
       FROM mailflow.account_configuration_revisions
       WHERE id = $1 AND account_key = $2 AND version = $3 AND digest = $4`,
      [
        revisionReference.revisionId,
        configuration.accountKey,
        revisionReference.version,
        revisionReference.digest,
      ],
    );
    if (stored.rows.length !== 1) {
      throw new TypeError('Configuration revision is not persisted for this account');
    }
    revision = revisionFromRow(stored.rows[0]);
  }
  const resolved = resolveEffectiveConfiguration(configuration.accountKey, revision);
  if (resolved.digest !== configuration.digest) {
    throw new TypeError('Effective configuration does not match its persisted revision');
  }
}

function createVersionedPersistenceAdapter(pool) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL pool is required');
  }

  async function persistConfigurationRevision(input) {
    object(input, ['requestId', 'accountKey', 'snapshot'], [], 'configuration revision request');
    const requestId = uuid(input.requestId, 'configuration request ID');
    const account = accountKey(input.accountKey);
    const snapshot = normalizeConfigurationSnapshot(account, input.snapshot);
    const digest = configurationSnapshotDigest(account, snapshot);

    return transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 3004))', [account]);
      const existing = await client.query(
        'SELECT id, version, account_key, snapshot, digest, created_at FROM mailflow.account_configuration_revisions WHERE account_key = $1 AND request_id = $2',
        [account, requestId],
      );
      if (existing.rows.length) {
        if (existing.rows[0].digest !== digest) {
          throw new Error('Configuration request ID already exists with different input');
        }
        return { revision: revisionFromRow(existing.rows[0]), alreadyProcessed: true };
      }

      const versionResult = await client.query(
        'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM mailflow.account_configuration_revisions WHERE account_key = $1',
        [account],
      );
      const inserted = await client.query(
        'INSERT INTO mailflow.account_configuration_revisions (account_key, request_id, version, snapshot, digest) VALUES ($1, $2, $3, $4, $5) RETURNING id, version, account_key, snapshot, digest, created_at',
        [account, requestId, versionResult.rows[0].version, snapshot, digest],
      );
      return { revision: revisionFromRow(inserted.rows[0]), alreadyProcessed: false };
    });
  }

  async function getConfigurationRevision(input) {
    object(input, ['accountKey', 'revisionId'], [], 'configuration revision query');
    const account = accountKey(input.accountKey);
    if (!Number.isSafeInteger(input.revisionId) || input.revisionId < 1) {
      throw new TypeError('Invalid configuration revision ID');
    }
    return readSnapshot(pool, async (client) => {
      const result = await client.query(
        `SELECT id, version, account_key, snapshot, digest, created_at
         FROM mailflow.account_configuration_revisions
         WHERE account_key = $1 AND id = $2`,
        [account, input.revisionId],
      );
      if (result.rows.length !== 1) {
        throw new Error('Configuration revision is not available for this account');
      }
      return revisionFromRow(result.rows[0]);
    });
  }

  async function persistedBatchResult(client, runId, account, alreadyProcessed) {
    const result = await client.query(
      `SELECT e.id::text AS evaluation_id, m.gmail_message_id
       FROM mailflow.evaluations e
       JOIN mailflow.messages m ON m.id = e.message_id AND m.account_key = e.account_key
       WHERE e.batch_id = $1 AND e.account_key = $2
       ORDER BY e.id`,
      [runId, account],
    );
    return {
      runId,
      alreadyProcessed,
      count: result.rows.length,
      evaluations: result.rows.map((row) => ({
        evaluationId: row.evaluation_id,
        messageId: row.gmail_message_id,
      })),
    };
  }

  async function persistEvaluationBatch(input) {
    const batch = normalizeEvaluationBatch(input);
    return transaction(pool, async (client) => {
      await validatePersistedConfiguration(client, batch.effectiveConfiguration);
      const insertedBatch = await client.query(
        'INSERT INTO mailflow.versioned_evaluation_batches (id, account_key, batch_hash, is_historical_replay) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id',
        [batch.runId, batch.accountKey, batch.batchHash, batch.isHistoricalReplay],
      );
      if (!insertedBatch.rows.length) {
        const existing = await client.query(
          'SELECT account_key, batch_hash FROM mailflow.versioned_evaluation_batches WHERE id = $1',
          [batch.runId],
        );
        if (
          existing.rows.length !== 1 ||
          existing.rows[0].account_key !== batch.accountKey ||
          existing.rows[0].batch_hash !== batch.batchHash
        ) {
          throw new Error('Evaluation run ID already exists with different input');
        }
        return persistedBatchResult(client, batch.runId, batch.accountKey, true);
      }

      const revision = batch.effectiveConfiguration.configurationRevision;
      const revisionValues = revision
        ? [revision.revisionId, revision.version, revision.digest]
        : [null, null, null];
      for (const item of batch.items) {
        await client.query(
          'INSERT INTO mailflow.messages (account_key, gmail_message_id, received_at) VALUES ($1, $2, $3) ON CONFLICT (account_key, gmail_message_id) DO NOTHING',
          [batch.accountKey, item.gmailMessageId, item.receivedAt],
        );
        const message = await client.query(
          'SELECT id FROM mailflow.messages WHERE account_key = $1 AND gmail_message_id = $2',
          [batch.accountKey, item.gmailMessageId],
        );
        if (message.rows.length !== 1) throw new Error('Message could not be located');
        const evaluation = await client.query(
          `INSERT INTO mailflow.evaluations
           (batch_id, account_key, message_id, schema_version, classification, policy,
            configuration_revision_id, configuration_version, configuration_digest,
            built_in_defaults_version, is_historical_replay)
           VALUES ($1, $2, $3, '1.0', $4, $5, $6, $7, $8, $9, $10)
           RETURNING id::text`,
          [
            batch.runId,
            batch.accountKey,
            message.rows[0].id,
            item.classification,
            item.policy,
            ...revisionValues,
            batch.effectiveConfiguration.builtInDefaultsVersion,
            batch.isHistoricalReplay,
          ],
        );
        const evaluationId = evaluation.rows[0].id;
        for (const assignment of item.effectiveTags.assignments) {
          const provenanceType = assignment.provenance.type;
          const provenanceReference =
            provenanceType === 'built_in_rule'
              ? assignment.provenance.ruleId
              : assignment.provenance.correctionId;
          await client.query(
            'INSERT INTO mailflow.evaluation_tag_assignments (evaluation_id, account_key, message_id, tag_id, provenance_type, provenance_reference) VALUES ($1, $2, $3, $4, $5, $6)',
            [
              evaluationId,
              batch.accountKey,
              message.rows[0].id,
              assignment.tagId,
              provenanceType,
              provenanceReference,
            ],
          );
        }
        if (item.makeCurrent) {
          await client.query(
            `INSERT INTO mailflow.current_effective_evaluations
             (account_key, message_id, evaluation_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (account_key, message_id)
             DO UPDATE SET evaluation_id = EXCLUDED.evaluation_id,
                           selected_at = clock_timestamp()`,
            [batch.accountKey, message.rows[0].id, evaluationId],
          );
        }
      }
      return persistedBatchResult(client, batch.runId, batch.accountKey, false);
    });
  }

  async function persistTagCorrection(input) {
    const correction = normalizeCorrection(input);
    const correctionHash = hash(correction);
    return transaction(pool, async (client) => {
      const base = await client.query(
        `SELECT e.id, r.snapshot
         FROM mailflow.evaluations e
         JOIN mailflow.messages m ON m.id = e.message_id AND m.account_key = e.account_key
         LEFT JOIN mailflow.account_configuration_revisions r
           ON r.id = e.configuration_revision_id AND r.account_key = e.account_key
         WHERE e.id = $1 AND e.account_key = $2 AND m.gmail_message_id = $3`,
        [correction.baseEvaluationId, correction.accountKey, correction.messageId],
      );
      if (
        base.rows.length !== 1 ||
        !definitionExists(base.rows[0].snapshot, correction.accountKey, correction.target.tagId)
      ) {
        throw new TypeError('Correction tag is not defined for the base evaluation');
      }
      const inserted = await client.query(
        `INSERT INTO mailflow.tag_corrections
         (correction_id, account_key, message_id, base_evaluation_id, schema_version,
          operation, tag_id, source, correction_hash)
         SELECT $1, $2, e.message_id, e.id, $3, $4, $5, $6, $7
         FROM mailflow.evaluations e
         JOIN mailflow.messages m ON m.id = e.message_id AND m.account_key = e.account_key
         WHERE e.id = $8 AND e.account_key = $2 AND m.gmail_message_id = $9
         ON CONFLICT (correction_id) DO NOTHING
         RETURNING sequence_id::text, created_at`,
        [
          correction.correctionId,
          correction.accountKey,
          correction.schemaVersion,
          correction.target.operation,
          correction.target.tagId,
          correction.source,
          correctionHash,
          correction.baseEvaluationId,
          correction.messageId,
        ],
      );
      if (inserted.rows.length) {
        return {
          correctionId: correction.correctionId,
          sequenceId: inserted.rows[0].sequence_id,
          createdAt: isoFromDatabase(inserted.rows[0].created_at),
          alreadyProcessed: false,
        };
      }
      const existing = await client.query(
        'SELECT correction_hash FROM mailflow.tag_corrections WHERE correction_id = $1',
        [correction.correctionId],
      );
      if (existing.rows.length !== 1 || existing.rows[0].correction_hash !== correctionHash) {
        throw new Error('Correction ID already exists with different input');
      }
      return {
        correctionId: correction.correctionId,
        alreadyProcessed: true,
      };
    });
  }

  async function resolveEffectiveTagsWithClient(client, account, evaluationId) {
    const evaluation = await client.query(
      `SELECT e.id::text, e.message_id, r.snapshot
       FROM mailflow.evaluations e
       LEFT JOIN mailflow.account_configuration_revisions r
         ON r.id = e.configuration_revision_id AND r.account_key = e.account_key
       WHERE e.id = $1 AND e.account_key = $2`,
      [evaluationId, account],
    );
    if (evaluation.rows.length !== 1) throw new Error('Evaluation could not be located');
    const base = await client.query(
      `SELECT tag_id, provenance_type, provenance_reference
       FROM mailflow.evaluation_tag_assignments
       WHERE evaluation_id = $1 AND account_key = $2
       ORDER BY tag_id`,
      [evaluationId, account],
    );
    const corrections = await client.query(
      `SELECT correction_id, operation, tag_id
       FROM mailflow.tag_corrections
       WHERE base_evaluation_id = $1 AND account_key = $2
       ORDER BY sequence_id`,
      [evaluationId, account],
    );
    const assignments = new Map(
      assignmentsFromRows(base.rows).map((assignment) => [assignment.tagId, assignment]),
    );
    for (const correction of corrections.rows) {
      if (correction.operation === 'remove') {
        assignments.delete(correction.tag_id);
      } else {
        assignments.set(correction.tag_id, {
          schemaVersion: '1.0',
          tagId: correction.tag_id,
          provenance: {
            type: 'user_correction',
            correctionId: correction.correction_id,
          },
        });
      }
    }
    const effectiveTags = {
      schemaVersion: '1.0',
      assignments: [...assignments.values()].sort((left, right) =>
        left.tagId.localeCompare(right.tagId),
      ),
    };
    return validateTaggingResult(effectiveTags, {
      accountKey: account,
      definitions: tagDefinitionsForConfiguration({
        tagDefinitions: evaluation.rows[0].snapshot?.tagDefinitions ?? [],
      }),
    });
  }

  async function resolveEffectiveTags(input) {
    object(input, ['accountKey', 'evaluationId'], [], 'effective tag query');
    const account = accountKey(input.accountKey);
    const evaluationId = identifier(input.evaluationId, EVALUATION_ID, 'evaluation ID', 20);
    return readSnapshot(pool, (client) =>
      resolveEffectiveTagsWithClient(client, account, evaluationId),
    );
  }

  async function selectCurrentEffectiveEvaluation(input) {
    object(input, ['accountKey', 'messageId', 'evaluationId'], [], 'current evaluation selection');
    const account = accountKey(input.accountKey);
    const messageId = identifier(input.messageId, IDENTIFIER, 'Gmail message ID', 256);
    const evaluationId = identifier(input.evaluationId, EVALUATION_ID, 'evaluation ID', 20);
    return transaction(pool, async (client) => {
      const selected = await client.query(
        `INSERT INTO mailflow.current_effective_evaluations
         (account_key, message_id, evaluation_id)
         SELECT e.account_key, e.message_id, e.id
         FROM mailflow.evaluations e
         JOIN mailflow.messages m ON m.id = e.message_id AND m.account_key = e.account_key
         WHERE e.id = $1 AND e.account_key = $2 AND m.gmail_message_id = $3
           AND e.policy->>'status' IN ('decided', 'insufficient_evidence')
         ON CONFLICT (account_key, message_id)
         DO UPDATE SET evaluation_id = EXCLUDED.evaluation_id,
                       selected_at = clock_timestamp()
         RETURNING evaluation_id::text`,
        [evaluationId, account, messageId],
      );
      if (!selected.rows.length) throw new Error('Evaluation does not match the account/message');
      return { evaluationId: selected.rows[0].evaluation_id, selected: true };
    });
  }

  async function getCurrentEffectiveEvaluation(input) {
    object(input, ['accountKey', 'messageId'], [], 'current evaluation query');
    const account = accountKey(input.accountKey);
    const messageId = identifier(input.messageId, IDENTIFIER, 'Gmail message ID', 256);
    return readSnapshot(pool, async (client) => {
      const current = await client.query(
        `SELECT e.id::text AS evaluation_id, m.gmail_message_id,
                e.classification, e.policy, e.configuration_revision_id,
                e.configuration_version, e.configuration_digest,
                e.built_in_defaults_version, e.evaluated_at
         FROM mailflow.current_effective_evaluations c
         JOIN mailflow.evaluations e
           ON e.id = c.evaluation_id AND e.account_key = c.account_key
             AND e.message_id = c.message_id
         JOIN mailflow.messages m
           ON m.id = c.message_id AND m.account_key = c.account_key
         WHERE c.account_key = $1 AND m.gmail_message_id = $2`,
        [account, messageId],
      );
      if (current.rows.length === 1) {
        const row = current.rows[0];
        const tagging = await resolveEffectiveTagsWithClient(client, account, row.evaluation_id);
        return {
          status: 'resolved',
          source: 'current_effective',
          evaluation: {
            schemaVersion: '1.0',
            evaluationId: row.evaluation_id,
            accountKey: account,
            messageId: row.gmail_message_id,
            evaluatedAt: isoFromDatabase(row.evaluated_at),
            classification: row.classification,
            tagging,
            policy: row.policy,
            configuration: configurationFromEvaluation(row),
          },
        };
      }
      if (current.rows.length > 1) {
        return { status: 'unresolved', reason: 'ambiguous_current_effective_state' };
      }

      const legacy = await client.query(
        `SELECT c.id, m.gmail_message_id, c.category, c.status AS classification_status,
                c.matched_rule_ids, c.explanation_codes AS classification_explanation_codes,
                c.processed_at, p.id AS policy_id, p.action, p.status AS policy_status,
                p.explanation_codes AS policy_explanation_codes
         FROM mailflow.messages m
         JOIN mailflow.classifications c
           ON c.message_id = m.id AND c.account_key = m.account_key
         JOIN mailflow.workflow_runs r
           ON r.id = c.run_id AND r.account_key = c.account_key
         LEFT JOIN mailflow.policy_decisions p ON p.classification_id = c.id
         WHERE m.account_key = $1 AND m.gmail_message_id = $2
         ORDER BY c.id
         LIMIT 2`,
        [account, messageId],
      );
      if (!legacy.rows.length) {
        return { status: 'unresolved', reason: 'no_current_or_legacy_evaluation' };
      }
      if (legacy.rows.length !== 1) {
        return { status: 'unresolved', reason: 'ambiguous_legacy_evaluations' };
      }
      const row = legacy.rows[0];
      const pair = validLegacyPair(row);
      if (!pair) return { status: 'unresolved', reason: 'invalid_legacy_evaluation' };
      return {
        status: 'resolved',
        source: 'legacy_fallback',
        evaluation: {
          schemaVersion: '1.0',
          evaluationId: String(row.id),
          accountKey: account,
          messageId: row.gmail_message_id,
          evaluatedAt: isoFromDatabase(row.processed_at),
          classification: pair.classification,
          tagging: { schemaVersion: '1.0', assignments: [] },
          policy: pair.policy,
          configuration: null,
        },
      };
    });
  }

  return {
    persistConfigurationRevision,
    getConfigurationRevision,
    persistEvaluationBatch,
    persistTagCorrection,
    resolveEffectiveTags,
    selectCurrentEffectiveEvaluation,
    getCurrentEffectiveEvaluation,
  };
}

module.exports = { createVersionedPersistenceAdapter };

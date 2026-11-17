'use strict';

const TAG_ID = /^[a-z][a-z0-9_]{0,63}$/;
const ACCOUNT_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const REFERENCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ASSIGNMENTS = 100;
const BUILT_IN_TAG_RULES = Object.freeze({
  application_rejection: 'rejection_application_outcome',
  interview_request: 'interview_invitation',
  screening_request: 'screening_invitation',
  application_confirmation: 'application_received',
  application_update: 'application_status_update',
  job_alert: 'job_alert_digest',
  recruiter_contact: 'recruiter_direct_outreach',
});
const BUILT_IN_TAG_NAMES = Object.freeze({
  application_rejection: 'Application rejection',
  interview_request: 'Interview request',
  screening_request: 'Screening request',
  application_confirmation: 'Application confirmation',
  application_update: 'Application update',
  job_alert: 'Job alert',
  recruiter_contact: 'Recruiter contact',
});
const BUILT_IN_TAG_DEFINITIONS = Object.freeze(
  Object.entries(BUILT_IN_TAG_RULES).map(([tagId]) =>
    Object.freeze({
      schemaVersion: '1.0',
      tagId,
      name: BUILT_IN_TAG_NAMES[tagId],
      owner: Object.freeze({ type: 'system' }),
      provenance: 'built_in',
    }),
  ),
);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
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

function tagId(value) {
  if (typeof value !== 'string' || !TAG_ID.test(value)) {
    throw new TypeError('Invalid tag ID');
  }
  return value;
}

function validateTagDefinition(input) {
  object(input, ['schemaVersion', 'tagId', 'name', 'owner', 'provenance'], 'tag definition');
  if (input.schemaVersion !== '1.0') throw new TypeError('Unsupported tag definition schema');
  const id = tagId(input.tagId);
  if (
    typeof input.name !== 'string' ||
    input.name.length < 1 ||
    input.name.length > 80 ||
    input.name.trim() !== input.name ||
    hasControlCharacter(input.name)
  ) {
    throw new TypeError('Invalid tag name');
  }
  if (!isPlainObject(input.owner)) throw new TypeError('Invalid tag owner');

  let owner;
  if (input.owner.type === 'system') {
    object(input.owner, ['type'], 'system tag owner');
    owner = { type: 'system' };
  } else if (input.owner.type === 'account') {
    object(input.owner, ['type', 'accountKey'], 'account tag owner');
    owner = { type: 'account', accountKey: accountKey(input.owner.accountKey) };
  } else {
    throw new TypeError('Invalid tag owner');
  }

  if (!['built_in', 'user_defined'].includes(input.provenance)) {
    throw new TypeError('Invalid tag definition provenance');
  }
  if (
    (owner.type === 'system' && input.provenance !== 'built_in') ||
    (owner.type === 'account' && input.provenance !== 'user_defined')
  ) {
    throw new TypeError('Tag owner and definition provenance do not match');
  }

  return {
    schemaVersion: '1.0',
    tagId: id,
    name: input.name,
    owner,
    provenance: input.provenance,
  };
}

function validateTagAssignment(input) {
  object(input, ['schemaVersion', 'tagId', 'provenance'], 'tag assignment');
  if (input.schemaVersion !== '1.0') throw new TypeError('Unsupported tag assignment schema');
  tagId(input.tagId);
  if (!isPlainObject(input.provenance)) throw new TypeError('Invalid assignment provenance');

  let provenance;
  if (input.provenance.type === 'built_in_rule') {
    object(input.provenance, ['type', 'ruleId'], 'built-in rule provenance');
    if (
      typeof input.provenance.ruleId !== 'string' ||
      !REFERENCE_ID.test(input.provenance.ruleId)
    ) {
      throw new TypeError('Invalid tag rule ID');
    }
    provenance = { type: 'built_in_rule', ruleId: input.provenance.ruleId };
  } else if (input.provenance.type === 'user_correction') {
    object(input.provenance, ['type', 'correctionId'], 'user correction provenance');
    if (
      typeof input.provenance.correctionId !== 'string' ||
      !REFERENCE_ID.test(input.provenance.correctionId)
    ) {
      throw new TypeError('Invalid tag correction ID');
    }
    provenance = {
      type: 'user_correction',
      correctionId: input.provenance.correctionId,
    };
  } else {
    throw new TypeError('Invalid assignment provenance type');
  }

  return { schemaVersion: '1.0', tagId: input.tagId, provenance };
}

function validateTaggingResult(input, context) {
  object(input, ['schemaVersion', 'assignments'], 'tagging result');
  if (input.schemaVersion !== '1.0') throw new TypeError('Unsupported tagging result schema');
  object(context, ['accountKey', 'definitions'], 'tagging context');
  const key = accountKey(context.accountKey);
  if (!Array.isArray(context.definitions) || context.definitions.length > MAX_ASSIGNMENTS) {
    throw new TypeError('Invalid tag definitions');
  }
  if (!Array.isArray(input.assignments) || input.assignments.length > MAX_ASSIGNMENTS) {
    throw new TypeError('Invalid tag assignments');
  }

  const definitions = new Map();
  for (const rawDefinition of context.definitions) {
    const definition = validateTagDefinition(rawDefinition);
    if (definition.owner.type === 'account' && definition.owner.accountKey !== key) {
      throw new TypeError('Tag definition belongs to a different account');
    }
    if (definitions.has(definition.tagId)) throw new TypeError('Duplicate tag definition');
    definitions.set(definition.tagId, definition);
  }

  const seen = new Set();
  const assignments = input.assignments.map((rawAssignment) => {
    const assignment = validateTagAssignment(rawAssignment);
    if (seen.has(assignment.tagId)) throw new TypeError('Duplicate tag assignment');
    seen.add(assignment.tagId);
    const definition = definitions.get(assignment.tagId);
    if (!definition) throw new TypeError('Tag assignment has no definition');
    if (assignment.provenance.type === 'built_in_rule' && definition.owner.type !== 'system') {
      throw new TypeError('Built-in rules may assign only built-in tags');
    }
    return assignment;
  });

  return { schemaVersion: '1.0', assignments };
}

function tagDefinitionsForConfiguration(configuration) {
  if (!isPlainObject(configuration) || !Array.isArray(configuration.tagDefinitions)) {
    throw new TypeError('Invalid effective tag definitions');
  }
  return [...BUILT_IN_TAG_DEFINITIONS, ...configuration.tagDefinitions];
}

function assignBuiltInTags(classification) {
  if (
    !isPlainObject(classification) ||
    classification.schemaVersion !== '1.0' ||
    typeof classification.status !== 'string' ||
    typeof classification.category !== 'string'
  ) {
    throw new TypeError('Invalid classification for tagging');
  }
  if (classification.status === 'insufficient_evidence' && classification.category === 'other') {
    return { schemaVersion: '1.0', assignments: [] };
  }
  const ruleId = BUILT_IN_TAG_RULES[classification.category];
  if (
    classification.status !== 'matched' ||
    !ruleId ||
    !Array.isArray(classification.matchedRuleIds) ||
    !classification.matchedRuleIds.includes(ruleId)
  ) {
    throw new TypeError('Classification does not support a built-in tag');
  }
  return {
    schemaVersion: '1.0',
    assignments: [
      {
        schemaVersion: '1.0',
        tagId: classification.category,
        provenance: { type: 'built_in_rule', ruleId },
      },
    ],
  };
}

module.exports = {
  BUILT_IN_TAG_DEFINITIONS,
  tagDefinitionsForConfiguration,
  assignBuiltInTags,
  validateTagDefinition,
  validateTagAssignment,
  validateTaggingResult,
};

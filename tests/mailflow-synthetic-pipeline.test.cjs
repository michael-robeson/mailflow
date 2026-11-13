'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { processSyntheticBatch } = require('../lib/pipeline-adapter.cjs');
const { evaluateNotificationPolicy } = require('../lib/notification-policy.cjs');
const { workflowErrors } = require('../scripts/validate.cjs');

const workflowPath = path.join(__dirname, '../workflows/04-mailflow-synthetic-pipeline.json');
const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const nodes = new Map(workflow.nodes.map((node) => [node.name, node]));
const messagesNode = nodes.get('Create Synthetic Gmail Messages');
const pipelineNode = nodes.get('Normalize Classify and Evaluate Policy');

function inputContext(items) {
  return {
    all: () => items,
    first: () => items[0],
  };
}

async function runCode(node, items) {
  assert.ok(node, 'Expected workflow Code node');
  assert.equal(node.type, 'n8n-nodes-base.code');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const localRequire = (name) => {
    assert.equal(name, 'mailflow-pipeline');
    return require('../lib');
  };
  const execute = new AsyncFunction('$input', 'require', node.parameters.jsCode);
  return await execute(inputContext(items), localRequire);
}

async function runWorkflowBatch(messages) {
  const output = await runCode(pipelineNode, [{ json: { messages } }]);
  return output[0].json;
}

test('synthetic workflow is inactive, test-only, and connected without Gmail or delivery nodes', () => {
  assert.equal(workflow.active, false);
  assert.match(workflow.name, /TEST ONLY - INACTIVE/);
  assert.deepEqual(workflow.pinData, {});
  assert.deepEqual(workflowErrors(workflow), []);
  assert.ok(workflow.nodes.every((node) =>
    !/gmail|httpRequest|emailSend|sms|scheduleTrigger/i.test(node.type)));
  assert.deepEqual(workflow.connections['Manual Trigger'].main[0][0], {
    node: 'Create Synthetic Gmail Messages',
    type: 'main',
    index: 0,
  });
  assert.deepEqual(workflow.connections['Create Synthetic Gmail Messages'].main[0][0], {
    node: 'Normalize Classify and Evaluate Policy',
    type: 'main',
    index: 0,
  });
});

test('workflow Code nodes produce a synthetic batch and invoke the shared pipeline package', async () => {
  assert.equal(messagesNode.parameters.mode, 'runOnceForAllItems');
  assert.equal(pipelineNode.parameters.mode, 'runOnceForAllItems');
  assert.match(pipelineNode.parameters.jsCode, /require\('mailflow-pipeline'\)/);

  const generated = await runCode(messagesNode, []);
  assert.equal(generated.length, 1);
  const report = await runWorkflowBatch(generated[0].json.messages);
  assert.deepEqual(report.results.map(({ category, action }) => ({ category, action })), [
    { category: 'interview_request', action: 'immediate' },
    { category: 'application_confirmation', action: 'daily' },
    { category: 'job_alert', action: 'weekly' },
  ]);
});

test('batch report correlates decisions by ordinal and excludes message content and identifiers', async () => {
  const generated = await runCode(messagesNode, []);
  const inputMessages = generated[0].json.messages;
  const report = await runWorkflowBatch(inputMessages);

  assert.deepEqual(report.results.map((entry) => entry.messageNumber), [1, 2, 3]);
  assert.deepEqual(report.results[0].matchedRuleIds, ['interview_invitation']);
  assert.deepEqual(report.results[0].explanationCodes, ['positive_rule_matched', 'default_action_selected']);
  const serialized = JSON.stringify(report);
  for (const message of inputMessages) {
    assert.ok(!serialized.includes(message.id));
    assert.ok(!serialized.includes(message.threadId));
    assert.ok(!serialized.includes(Buffer.from(message.payload.body.data, 'base64url').toString('utf8')));
  }
});

test('malformed messages produce safe none decisions without suppressing valid batch results', async () => {
  const generated = await runCode(messagesNode, []);
  const validMessages = generated[0].json.messages;
  const throwingMessage = new Proxy({}, {
    get(target, property, receiver) {
      if (property === 'payload') throw new Error('synthetic processing failure');
      return Reflect.get(target, property, receiver);
    },
  });
  const report = await runWorkflowBatch([validMessages[0], throwingMessage, null, validMessages[2]]);

  assert.equal(report.results.length, 4);
  assert.deepEqual(report.results[0], {
    messageNumber: 1,
    category: 'interview_request',
    action: 'immediate',
    matchedRuleIds: ['interview_invitation'],
    explanationCodes: ['positive_rule_matched', 'default_action_selected'],
    status: 'decided',
  });
  assert.deepEqual(report.results[1], {
    messageNumber: 2,
    category: 'other',
    action: 'none',
    matchedRuleIds: [],
    explanationCodes: ['message_processing_failed'],
    status: 'processing_error',
  });
  assert.equal(report.results[2].action, 'none');
  assert.equal(report.results[3].category, 'job_alert');
  assert.equal(report.results[3].action, 'weekly');
  assert.ok(!JSON.stringify(report).includes('synthetic processing failure'));
});

test('invalid batches fail closed to a structured none decision', () => {
  assert.deepEqual(processSyntheticBatch(null), {
    schemaVersion: '1.0',
    results: [{
      messageNumber: null,
      category: 'other',
      action: 'none',
      matchedRuleIds: [],
      explanationCodes: ['invalid_message_batch'],
      status: 'invalid_input',
    }],
  });
});

test('invalid and unsupported classification inputs always produce none decisions', () => {
  const cases = [
    { category: 'interview_request', status: 'matched' },
    { schemaVersion: '2.0', category: 'interview_request', status: 'matched' },
    { schemaVersion: '1.0', category: 'interview_request', status: 'unsupported_schema' },
    { schemaVersion: '1.0', category: 'future_category', status: 'matched' },
  ];

  for (const classification of cases) {
    assert.equal(evaluateNotificationPolicy(classification).action, 'none');
  }
});

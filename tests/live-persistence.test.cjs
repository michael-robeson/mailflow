'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { workflowErrors } = require('../scripts/validate.cjs');
const { processGmailResponse } = require('../lib/gmail-live.cjs');
const { createLivePersistenceBatch, persistLiveBatch } = require('../lib/live-persistence.cjs');

const workflow = JSON.parse(fs.readFileSync('workflows/06-mailflow-gmail-persistence.json', 'utf8'));
const syntheticWorkflow = JSON.parse(fs.readFileSync('workflows/07-mailflow-persistence-synthetic.json', 'utf8'));
const runId = '12345678-1234-4234-8234-123456789abc';
function response(id) {
  return { statusCode: 200, body: {
    id, threadId: 'private_thread', internalDate: '1704067200000',
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'Subject', value: 'Interview invitation' }, { name: 'From', value: 'test@example.test' }],
      body: { data: Buffer.from('Schedule an interview.').toString('base64url') },
    },
  } };
}

test('persistence workflow is manual, unbound, capped, read-only and refuses an unset run ID', async () => {
  assert.equal(workflow.active, false);
  assert.deepEqual(workflow.pinData, {});
  assert.deepEqual(workflowErrors(workflow), []);
  assert.equal(workflow.settings.saveManualExecutions, false);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveExecutionProgress, false);
  assert.equal(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.manualTrigger').length, 1);
  assert.deepEqual([...new Set(workflow.nodes.map((node) => node.type))].sort(),
    ['n8n-nodes-base.code', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.if', 'n8n-nodes-base.manualTrigger']);
  const requests = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ parameters }) => parameters.method === 'GET' && parameters.url.includes('https://gmail.googleapis.com/gmail/v1/users/me/messages')));
  const configure = workflow.nodes.find((node) => node.name === 'Configure Persistence Run');
  assert.match(configure.parameters.jsCode, /const limit = 25/);
  assert.match(configure.parameters.jsCode, /const query = 'newer_than:14d';/);
  assert.match(configure.parameters.jsCode, /const accountKey = '';/);
  assert.match(configure.parameters.jsCode, /const runId = '';/);
  assert.ok(requests.every((node) => !node.credentials));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await assert.rejects(new AsyncFunction(configure.parameters.jsCode)(), /run UUID/);
  const withRunId = configure.parameters.jsCode.replace("const runId = '';", `const runId = '${runId}';`);
  await assert.rejects(new AsyncFunction(withRunId)(), /account key/);
  const configured = withRunId.replace("const accountKey = '';", "const accountKey = 'synthetic_account';");
  assert.deepEqual(await new AsyncFunction(configured)(),
    [{ json: { limit: 25, query: 'newer_than:14d', accountKey: 'synthetic_account', runId } }]);
});

test('synthetic runtime workflow is inactive and has no network nodes', () => {
  assert.equal(syntheticWorkflow.active, false);
  assert.deepEqual(workflowErrors(syntheticWorkflow), []);
  assert.deepEqual(syntheticWorkflow.nodes.map(({ type }) => type),
    ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.code']);
  assert.equal(syntheticWorkflow.settings.saveManualExecutions, false);
});

test('mapping preserves separate decisions and excludes sensitive values from report and database input', () => {
  const good = processGmailResponse('private_message', response('private_message'), 1);
  const failed = processGmailResponse('failed_message', { statusCode: 404 }, 2);
  assert.equal(good.persistence.threadId, 'private_thread');
  const { batch, report } = createLivePersistenceBatch(runId, 'synthetic_account', [good, failed]);
  assert.equal(batch.items[0].gmailMessageId, 'private_message');
  assert.equal(batch.items[0].classification.status, 'matched');
  assert.equal(batch.items[0].policy.status, 'decided');
  assert.equal(batch.items[0].receivedAt, '2024-01-01T00:00:00.000Z');
  assert.equal(batch.items[1].classification.status, 'retrieval_error');
  assert.equal(batch.items[1].policy.action, 'none');
  assert.equal(report.retrievalErrors, 1);
  assert.equal(report.processingErrors, 0);
  for (const privateValue of ['private_message', 'private_thread', 'Interview invitation', 'test@example.test', 'Schedule an interview.']) {
    assert.ok(!JSON.stringify(report).includes(privateValue));
  }
  for (const privateValue of ['private_thread', 'Interview invitation', 'test@example.test', 'Schedule an interview.']) {
    assert.ok(!JSON.stringify(batch).includes(privateValue));
  }
  assert.throws(() => createLivePersistenceBatch(runId, 'a', [{ ...good, persistence: null }]), /Missing persistence/);
});

test('individual processing failures retain identity and are represented safely', () => {
  const broken = response('broken');
  Object.defineProperty(broken.body, 'internalDate', { get() { throw new Error('private synthetic error'); } });
  const failed = processGmailResponse('broken', broken, 1);
  const successful = processGmailResponse('success', response('success'), 2);
  const { batch, report } = createLivePersistenceBatch(runId, 'synthetic_account', [failed, successful]);
  assert.equal(report.processingErrors, 1);
  assert.equal(batch.items[0].classification.status, 'processing_error');
  assert.equal(batch.items[0].policy.action, 'none');
  assert.equal(batch.items[1].classification.category, 'interview_request');
  assert.ok(!JSON.stringify(report).includes('private synthetic error'));
  const invalidThread = response('bad_thread');
  Object.defineProperty(invalidThread.body, 'threadId', { get() { throw new Error('private thread failure'); } });
  const result = processGmailResponse('bad_thread', invalidThread, 1);
  assert.equal(result.decision.status, 'processing_error');
  assert.equal(result.persistence.threadId, null);
});

test('persistence errors propagate and no success-shaped report is returned', async () => {
  const processed = [processGmailResponse('id1', response('id1'), 1)];
  await assert.rejects(persistLiveBatch({ connect: async () => { throw new Error('synthetic unavailable'); } }, runId, 'account', processed), /unavailable/);
});

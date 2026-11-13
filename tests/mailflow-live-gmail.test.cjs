'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const pipeline = require('../lib');
const { workflowErrors } = require('../scripts/validate.cjs');

const workflow = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../workflows/05-mailflow-live-gmail.json'), 'utf8',
));
const nodes = new Map(workflow.nodes.map((node) => [node.name, node]));
const item = (json) => ({ json });

async function runCode(name, items, otherNodes = {}) {
  const node = nodes.get(name);
  assert.equal(node.type, 'n8n-nodes-base.code');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('$input', '$', 'require', node.parameters.jsCode);
  const input = { all: () => items, first: () => items[0] };
  const lookup = (nodeName) => {
    assert.ok(otherNodes[nodeName], `Unexpected node lookup ${nodeName}`);
    return { all: () => otherNodes[nodeName], first: () => otherNodes[nodeName][0] };
  };
  return execute(input, lookup, (name) => {
    assert.equal(name, 'mailflow-pipeline');
    return pipeline;
  });
}

function expression(value, json) {
  const source = value.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
  return new Function('$json', `return (${source});`)(json);
}

function message(id, subject = 'Synthetic interview invitation', body = 'We would like to schedule an interview.') {
  return {
    id,
    threadId: `thread-${id}`,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Synthetic Hiring <hiring@example.test>' },
        { name: 'Subject', value: subject },
      ],
      body: { data: Buffer.from(body).toString('base64url') },
    },
  };
}

async function prepare(messages, limit = 25) {
  return runCode('Prepare Message IDs', [item(messages)], {
    'Configure Live Processing': [item({ limit, query: '' })],
  });
}

async function process(requests, responses) {
  return runCode('Process Gmail Responses', responses, { 'Prepare Message IDs': requests });
}

test('workflow is manual, inactive, read-only, unbound, and does not save execution data', () => {
  assert.equal(workflow.active, false);
  assert.deepEqual(workflow.pinData, {});
  assert.deepEqual(workflowErrors(workflow), []);
  assert.deepEqual(workflow.settings, {
    executionOrder: 'v1',
    saveDataErrorExecution: 'none',
    saveDataSuccessExecution: 'none',
    saveManualExecutions: false,
    saveExecutionProgress: false,
  });
  assert.deepEqual([...new Set(workflow.nodes.map((node) => node.type))].sort(), [
    'n8n-nodes-base.code', 'n8n-nodes-base.httpRequest',
    'n8n-nodes-base.if', 'n8n-nodes-base.manualTrigger',
  ]);
  assert.equal(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.manualTrigger').length, 1);
  const requests = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest');
  assert.equal(requests.length, 2);
  for (const { parameters } of requests) {
    assert.equal(parameters.method, 'GET');
    assert.equal(parameters.authentication, 'genericCredentialType');
    assert.equal(parameters.genericAuthType, 'oAuth2Api');
    assert.match(parameters.url, /^=\{\{ 'https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages/);
  }
  assert.equal(nodes.get('Get Full Gmail Message').onError, 'continueRegularOutput');
  assert.deepEqual(nodes.get('Get Full Gmail Message').parameters.options.response.response, {
    neverError: true, responseFormat: 'json', fullResponse: true,
  });
  assert.deepEqual(workflow.connections['Has Messages'].main.map((branch) => branch[0].node), [
    'Get Full Gmail Message', 'Empty Classification Report',
  ]);
});

test('configuration and request URLs enforce bounds and escape the Gmail query and ID', async () => {
  const [configured] = await runCode('Configure Live Processing', [item({})]);
  assert.deepEqual(configured.json, { limit: 25, query: 'newer_than:14d' });
  const query = 'from:someone@example.test subject:"a & b"';
  const listUrl = new URL(expression(nodes.get('List Gmail Messages').parameters.url, { limit: 25, query }));
  assert.equal(listUrl.origin, 'https://gmail.googleapis.com');
  assert.equal(listUrl.searchParams.get('maxResults'), '25');
  assert.equal(listUrl.searchParams.get('q'), query);
  const defaultUrl = new URL(expression(nodes.get('List Gmail Messages').parameters.url, configured.json));
  assert.equal(defaultUrl.searchParams.get('q'), 'newer_than:14d');
  const emptyQueryUrl = new URL(expression(nodes.get('List Gmail Messages').parameters.url, { limit: 25, query: '' }));
  assert.equal(emptyQueryUrl.searchParams.has('q'), false);
  const getUrl = new URL(expression(nodes.get('Get Full Gmail Message').parameters.url, { id: 'a_b-123' }));
  assert.equal(getUrl.pathname, '/gmail/v1/users/me/messages/a_b-123');
  assert.equal(getUrl.searchParams.get('format'), 'full');
  for (const limit of [0, 26, -1, 1.5, '25']) {
    assert.throws(() => pipeline.prepareGmailMessageList({}, limit), /limit/);
  }
});

test('list handling bounds retrieval and rejects invalid or duplicate IDs', async () => {
  for (const response of [{}, { messages: [] }]) {
    assert.deepEqual(await prepare(response), [item({ hasMessage: false })]);
  }
  assert.deepEqual((await runCode('Empty Classification Report', [item({})]))[0].json, {
    schemaVersion: '1.0', results: [], diagnostics: {
      normalizedMessages: 0,
      messagesWithSubject: 0,
      messagesWithBody: 0,
      messagesWithSenderAddress: 0,
      messagesWithNormalizationWarnings: 0,
      categoryCounts: {},
      matchedRuleCounts: {},
    },
  });
  const ids = Array.from({ length: 25 }, (_, index) => ({ id: `m${index}` }));
  assert.equal((await prepare({ messages: ids })).length, 25);
  await assert.rejects(prepare({ messages: [...ids, { id: 'm25' }] }), /oversized/);
  await assert.rejects(prepare({ messages: ids.slice(0, 3) }, 2), /oversized/);
  for (const messages of [[{ id: 'bad/id' }], [{ id: 'same' }, { id: 'same' }], [null], null, {}]) {
    await assert.rejects(prepare({ messages }), /Invalid/);
  }
  await assert.rejects(prepare({ error: 'synthetic error' }), /Invalid/);
});

test('reports classify successes and isolate HTTP, malformed response, and processing failures', async () => {
  const requests = await prepare({ messages: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })) });
  const brokenMessage = message('d');
  Object.defineProperty(brokenMessage, 'internalDate', {
    get() { throw new Error('private synthetic error'); },
  });
  const responses = [
    { json: { statusCode: 200, body: message('e', 'Synthetic job alert', 'New jobs matching your preferences.') }, pairedItem: { item: 4 } },
    { json: { statusCode: 404, body: { error: 'private HTTP error' } }, pairedItem: { item: 1 } },
    { json: { statusCode: 200, body: message('a') }, pairedItem: { item: 0 } },
    { json: { statusCode: 200, body: message('wrong') }, pairedItem: { item: 2 } },
    { json: { statusCode: 200, body: brokenMessage }, pairedItem: { item: 3 } },
  ];
  const processed = await process(requests, responses);
  assert.deepEqual(processed.map(({ json }) => json.messageId), ['a', 'b', 'c', 'd', 'e']);
  const report = (await runCode('Sanitized Classification Report', processed))[0].json;
  assert.deepEqual(report.results.map(({ category, action, status }) => [category, action, status]), [
    ['interview_request', 'immediate', 'decided'],
    ['other', 'none', 'retrieval_error'],
    ['other', 'none', 'retrieval_error'],
    ['other', 'none', 'processing_error'],
    ['job_alert', 'weekly', 'decided'],
  ]);
  assert.deepEqual(report.results[1].explanationCodes, ['gmail_message_retrieval_failed']);
  assert.deepEqual(report.results[2].explanationCodes, ['invalid_gmail_message_response']);
  assert.deepEqual(report.results[3].explanationCodes, ['message_processing_failed']);
  assert.deepEqual(report.results[0].matchedRuleIds, ['interview_invitation']);
  assert.deepEqual(report.diagnostics, {
    normalizedMessages: 2,
    messagesWithSubject: 2,
    messagesWithBody: 2,
    messagesWithSenderAddress: 2,
    messagesWithNormalizationWarnings: 0,
    categoryCounts: { interview_request: 1, other: 3, job_alert: 1 },
    matchedRuleCounts: { interview_invitation: 1, job_alert_digest: 1 },
  });
  for (const [index, result] of report.results.entries()) {
    assert.equal(result.messageNumber, index + 1);
    assert.deepEqual(Object.keys(result).sort(), [
      'action', 'category', 'explanationCodes', 'matchedRuleIds', 'messageNumber', 'status',
    ]);
  }
  const serialized = JSON.stringify(report);
  for (const privateValue of ['thread-a', 'hiring@example.test', 'Synthetic interview invitation',
    'We would like to schedule an interview.', message('a').payload.body.data, 'private HTTP error',
    'private synthetic error', 'messageId']) {
    assert.ok(!serialized.includes(privateValue), `Report leaked ${privateValue}`);
  }
});

test('Gmail full response MIME parts and root headers reach the shared classifier', async () => {
  const encode = (value) => Buffer.from(value).toString('base64url');
  const messages = [
    {
      id: 'synthetic_multipart',
      threadId: 'synthetic_thread',
      internalDate: '1704067200000',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'FROM', value: 'Example Hiring <recruiter@example.test>' },
          { name: 'sUbJeCt', value: 'General update' },
        ],
        parts: [{
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }],
              body: { data: encode('We would like to schedule an interview.') } },
            { mimeType: 'text/html', body: { data: encode('<p>HTML duplicate</p>') } },
          ],
        }],
      },
    },
    {
      id: 'synthetic_subject',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Application received' }],
        body: {},
      },
    },
    {
      id: 'synthetic_html',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'From', value: 'alerts@example.test' }],
        parts: [
          { mimeType: 'text/plain', body: { attachmentId: 'external-synthetic-body' } },
          { mimeType: 'text/html', body: { data: encode('<p>New jobs matching your preferences.</p>') } },
        ],
      },
    },
    {
      id: 'synthetic_encoded_header',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: '=?UTF-8?B?SW50ZXJ2aWV3IGludml0YXRpb24=?=' }],
        body: { data: '%' },
      },
    },
  ];
  const requests = await prepare({ messages: messages.map(({ id }) => ({ id })) });
  const responses = messages.map((body, index) => ({
    json: { statusCode: 200, body }, pairedItem: { item: index },
  }));
  const processed = await process(requests, responses);
  const report = (await runCode('Sanitized Classification Report', processed))[0].json;
  assert.deepEqual(report.results.map(({ category }) => category), [
    'interview_request', 'application_confirmation', 'job_alert', 'other',
  ]);
  assert.deepEqual(report.diagnostics, {
    normalizedMessages: 4,
    messagesWithSubject: 3,
    messagesWithBody: 2,
    messagesWithSenderAddress: 2,
    messagesWithNormalizationWarnings: 2,
    categoryCounts: { interview_request: 1, application_confirmation: 1, job_alert: 1, other: 1 },
    matchedRuleCounts: { interview_invitation: 1, application_received: 1, job_alert_digest: 1 },
  });
  const serialized = JSON.stringify(report);
  for (const privateValue of [
    'synthetic_multipart', 'synthetic_thread', 'recruiter@example.test', 'General update',
    'We would like to schedule an interview.', '=?UTF-8?B?SW50ZXJ2aWV3IGludml0YXRpb24=?=',
    encode('New jobs matching your preferences.'), 'external-synthetic-body',
  ]) {
    assert.ok(!serialized.includes(privateValue), 'Report contains synthetic input data');
  }
});

test('a full 25-message synthetic batch produces exactly 25 ordered decisions', async () => {
  const ids = Array.from({ length: 25 }, (_, index) => ({ id: `synthetic_id_${index}` }));
  const requests = await prepare({ messages: ids });
  const responses = ids.map(({ id }, index) => ({
    json: { statusCode: 200, body: message(id) }, pairedItem: { item: index },
  }));
  const processed = await process(requests, responses);
  const report = (await runCode('Sanitized Classification Report', processed))[0].json;
  assert.equal(report.results.length, 25);
  assert.deepEqual(report.results.map((result) => result.messageNumber), Array.from({ length: 25 }, (_, i) => i + 1));
  assert.ok(report.results.every((result) => result.category === 'interview_request' && result.action === 'immediate'));
  for (const { id } of ids) assert.ok(!JSON.stringify(report).includes(id));
});

test('diagnostics count every matched rule, including multiple rules for one message', async () => {
  const requests = await prepare({ messages: [{ id: 'synthetic_multi' }] });
  const body = message('synthetic_multi', 'Interview invitation', 'We have received your application.');
  const processed = await process(requests, [{ json: { statusCode: 200, body }, pairedItem: { item: 0 } }]);
  const report = (await runCode('Sanitized Classification Report', processed))[0].json;
  assert.equal(report.diagnostics.normalizedMessages, 1);
  assert.deepEqual(report.diagnostics.categoryCounts, { interview_request: 1 });
  assert.deepEqual(report.diagnostics.matchedRuleCounts, {
    interview_invitation: 1, application_received: 1,
  });
  assert.ok(report.results[0].explanationCodes.includes('precedence_applied'));
});

test('transport errors continue safely and mismatched associations fail explicitly', async () => {
  const requests = await prepare({ messages: [{ id: 'first' }, { id: 'second' }] });
  const transportError = { json: { error: 'sensitive transport error' }, pairedItem: { item: 0 } };
  const success = { json: { statusCode: 200, body: message('second') }, pairedItem: { item: 1 } };
  const results = await process(requests, [transportError, success]);
  assert.equal(results[0].json.decision.status, 'retrieval_error');
  assert.equal(results[1].json.decision.category, 'interview_request');
  await assert.rejects(process(requests, [success]), /count/);
  await assert.rejects(process(requests, [success, success]), /association/);
  await assert.rejects(process(requests, [transportError, { json: {} }]), /association/);
  assert.throws(() => pipeline.sanitizeGmailReport(Array.from({ length: 26 })), /oversized/);
  assert.throws(() => pipeline.sanitizeGmailReport([{ decision: { messageNumber: 2 } }]), /order/);
});

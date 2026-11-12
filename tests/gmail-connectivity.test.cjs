const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../workflows/01-gmail-connectivity.json'),
  'utf8',
));
const node = (name) => {
  const result = workflow.nodes.find((entry) => entry.name === name);
  assert.ok(result, `Missing node: ${name}`);
  return result;
};
const runCode = (name, input) => new Function('$input', node(name).parameters.jsCode)(input);

test('workflow is manual, unpinned, and does not save execution data', () => {
  assert.equal(workflow.name, '01 - Gmail Connectivity Test');
  assert.equal(workflow.active, false);
  assert.deepEqual(workflow.pinData, {});
  assert.equal(workflow.settings.saveManualExecutions, false);
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveExecutionProgress, false);
  assert.equal(workflow.nodes.filter((entry) => entry.type.endsWith('.manualTrigger')).length, 1);
  assert.deepEqual(workflow.nodes.map((entry) => entry.name), [
    'Manual Trigger', 'List Messages', 'Limit Message IDs', 'Get Message Metadata', 'Show Metadata',
  ]);
  for (const [source, target] of [
    ['Manual Trigger', 'List Messages'],
    ['List Messages', 'Limit Message IDs'],
    ['Limit Message IDs', 'Get Message Metadata'],
    ['Get Message Metadata', 'Show Metadata'],
  ]) {
    assert.deepEqual(workflow.connections[source].main, [[{ node: target, type: 'main', index: 0 }]]);
  }
});

test('requests use only GET endpoints and metadata fields without embedded credentials', () => {
  const list = node('List Messages');
  const detail = node('Get Message Metadata');
  for (const entry of [list, detail]) {
    assert.equal(entry.type, 'n8n-nodes-base.httpRequest');
    assert.ok(entry.parameters.method === undefined || entry.parameters.method === 'GET');
    assert.equal(entry.parameters.authentication, 'genericCredentialType');
    assert.equal(entry.parameters.genericAuthType, 'oAuth2Api');
    assert.equal(entry.credentials, undefined);
  }
  const url = new URL(list.parameters.url);
  assert.equal(url.origin + url.pathname, 'https://gmail.googleapis.com/gmail/v1/users/me/messages');
  assert.equal(url.searchParams.get('maxResults'), '5');
  assert.equal(url.searchParams.get('fields'), 'messages(id)');
  assert.equal([...url.searchParams.keys()].length, 2);
  assert.match(detail.parameters.url, /gmail\/v1\/users\/me\/messages\//);
  assert.match(detail.parameters.url, /format=metadata/);
  assert.match(detail.parameters.url, /metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date/);
  assert.match(detail.parameters.url, /fields=id%2ClabelIds%2Cpayload%28headers%28name%2Cvalue%29%29/);
  assert.doesNotMatch(JSON.stringify(workflow), /access_token|refresh_token|client_secret|clientSecret/i);
});

test('message list is capped at five and rejects malformed IDs', () => {
  const input = (messages) => ({ first: () => ({ json: messages === undefined ? {} : { messages } }) });
  assert.deepEqual(runCode('Limit Message IDs', input(undefined)), []);
  assert.deepEqual(runCode('Limit Message IDs', input(Array.from({ length: 7 }, (_, i) => ({ id: `id${i}` })))),
    Array.from({ length: 5 }, (_, i) => ({ json: { id: `id${i}` } })));
  assert.throws(() => runCode('Limit Message IDs', input({})), /Unexpected Gmail message list/);
  assert.throws(() => runCode('Limit Message IDs', input([{ id: '../other' }])), /Unexpected Gmail message ID/);
});

test('output contains only the requested synthetic metadata', () => {
  const input = { all: () => [{ json: {
    id: 'synthetic123',
    labelIds: ['INBOX'],
    payload: { headers: [
      { name: 'From', value: 'Example Sender' },
      { name: 'Subject', value: 'Synthetic subject' },
      { name: 'Date', value: 'Mon, 1 Jan 2024 00:00:00 +0000' },
    ] },
  } }, { json: { id: 'synthetic456' } }] };
  assert.deepEqual(runCode('Show Metadata', input), [
    { json: { id: 'synthetic123', sender: 'Example Sender', subject: 'Synthetic subject', date: 'Mon, 1 Jan 2024 00:00:00 +0000', labels: ['INBOX'] } },
    { json: { id: 'synthetic456', sender: null, subject: null, date: null, labels: [] } },
  ]);
});

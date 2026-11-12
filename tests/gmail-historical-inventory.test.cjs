const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../workflows/02-gmail-historical-inventory.json'),
  'utf8',
));
const node = (name) => {
  const result = workflow.nodes.find((entry) => entry.name === name);
  assert.ok(result, `Missing node: ${name}`);
  return result;
};
const run = (name, input, limit = 100) => new Function('$input', '$', node(name).parameters.jsCode)(
  input,
  (name) => {
    assert.equal(name, 'Configure Inventory');
    return { first: () => ({ json: { limit } }) };
  },
);
const list = (messages) => ({ first: () => ({ json: messages === undefined ? {} : { messages } }) });
const metadata = (id, headers) => ({ json: { id, labelIds: ['INBOX'], payload: { headers } } });
const header = (name, value) => ({ name, value });

test('workflow is manual, unbound, inactive, unpinned and disables execution saves', () => {
  assert.equal(workflow.name, '02 - Gmail Historical Inventory');
  assert.equal(workflow.active, false);
  assert.deepEqual(workflow.pinData, {});
  assert.deepEqual(workflow.settings, {
    executionOrder: 'v1',
    saveDataErrorExecution: 'none',
    saveDataSuccessExecution: 'none',
    saveManualExecutions: false,
    saveExecutionProgress: false,
  });
  assert.equal(workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.manualTrigger').length, 1);
  assert.equal(workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').length, 2);
  assert.ok(workflow.nodes.every((n) => !n.credentials));
  assert.doesNotMatch(JSON.stringify(workflow), /access_token|refresh_token|client_secret|clientSecret/i);
  for (const [source, target] of [
    ['Manual Trigger', 'Configure Inventory'], ['Configure Inventory', 'List Messages'],
    ['List Messages', 'Prepare Message IDs'], ['Prepare Message IDs', 'Has Messages'],
    ['Get Message Metadata', 'Sender Inventory Report'],
  ]) {
    assert.deepEqual(workflow.connections[source].main, [[{ node: target, type: 'main', index: 0 }]]);
  }
  assert.deepEqual(workflow.connections['Has Messages'].main, [
    [{ node: 'Get Message Metadata', type: 'main', index: 0 }],
    [{ node: 'Empty Inventory Report', type: 'main', index: 0 }],
  ]);
  assert.deepEqual(node('Has Messages').parameters.conditions.boolean, [
    { value1: '={{ $json.hasMessage }}', operation: 'equal', value2: true },
  ]);
});

test('requests use only bounded single-page GET and metadata-only GET', () => {
  const limit = run('Configure Inventory', {})[0].json.limit;
  assert.equal(limit, 100);
  const listNode = node('List Messages');
  const detail = node('Get Message Metadata');
  for (const entry of [listNode, detail]) {
    assert.equal(entry.parameters.method ?? 'GET', 'GET');
    assert.equal(entry.parameters.authentication, 'genericCredentialType');
    assert.equal(entry.parameters.genericAuthType, 'oAuth2Api');
    assert.deepEqual(entry.parameters.options, {});
  }
  const expression = listNode.parameters.url;
  const evaluate = new Function('$json', `return (${expression.slice(3, -3)});`);
  const url = new URL(evaluate({ limit }));
  assert.equal(url.origin + url.pathname, 'https://gmail.googleapis.com/gmail/v1/users/me/messages');
  assert.equal(url.searchParams.get('maxResults'), '100');
  assert.equal(url.searchParams.get('fields'), 'messages(id)');
  assert.equal([...url.searchParams.keys()].length, 2);
  const get = new Function('$json', `return (${detail.parameters.url.slice(3, -3)});`);
  const detailUrl = new URL(get({ id: 'synthetic123' }));
  assert.equal(detailUrl.origin + detailUrl.pathname, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/synthetic123');
  assert.equal(detailUrl.searchParams.get('format'), 'metadata');
  assert.deepEqual(detailUrl.searchParams.getAll('metadataHeaders'), ['From', 'Subject', 'Date', 'List-Unsubscribe', 'Precedence']);
  assert.equal(detailUrl.searchParams.get('fields'), 'id,labelIds,payload(headers(name,value))');
  assert.equal([...detailUrl.searchParams.keys()].length, 7);
});

test('configured limit rejects values outside the permitted integer range', () => {
  const code = node('Configure Inventory').parameters.jsCode;
  for (const limit of ['0', '101', '1.5']) {
    assert.throws(() => new Function(code.replace('const limit = 100;', `const limit = ${limit};`))(), /integer from 1 to 100/);
  }
});

test('empty mailbox and bounded IDs route correctly and invalid input fails', () => {
  assert.deepEqual(run('Prepare Message IDs', list(undefined)), [{ json: { hasMessage: false } }]);
  assert.deepEqual(run('Prepare Message IDs', list([])), [{ json: { hasMessage: false } }]);
  assert.deepEqual(run('Empty Inventory Report', {}), [{ json: { messagesAnalyzed: 0, unknownSenderCount: 0, senders: [] } }]);
  assert.equal(run('Prepare Message IDs', list(Array.from({ length: 100 }, (_, i) => ({ id: `id${i}` })))).length, 100);
  assert.throws(() => run('Prepare Message IDs', list(Array.from({ length: 101 }, (_, i) => ({ id: `id${i}` })))), /exceeds/);
  assert.throws(() => run('Prepare Message IDs', list([{ id: 'id1' }, { id: 'id2' }]), 1), /exceeds/);
  assert.throws(() => run('Prepare Message IDs', list([{ id: '../other' }])), /Unexpected/);
  assert.throws(() => run('Prepare Message IDs', list([{ id: 'id1' }, { id: 'id1' }])), /duplicate/);
  assert.throws(() => run('Prepare Message IDs', list({})), /Unexpected/);
});

test('synthetic senders are normalized, counted, sorted, and explained conservatively', () => {
  const items = [
    metadata('id1', [header('From', 'Example <NEWS@EXAMPLE.TEST>'), header('List-Unsubscribe', '<https://example.test/unsubscribe>')]),
    metadata('id2', [header('from', 'news@example.test'), header('Precedence', 'Bulk')]),
    metadata('id3', [header('From', 'no-reply@example.test')]),
    metadata('id4', [header('From', 'Person <a@example.test>'), header('Subject', 'Synthetic subject')]),
    metadata('id5', [header('From', 'invalid address')]),
    metadata('id6', []),
    metadata('id7', [header('From', 'a@example.test'), header('From', 'b@example.test')]),
  ];
  const report = run('Sender Inventory Report', { all: () => items })[0].json;
  assert.equal(report.messagesAnalyzed, 7);
  assert.equal(report.unknownSenderCount, 3);
  assert.deepEqual(report.senders, [
    { sender: 'news@example.test', count: 2, signals: { listUnsubscribe: 1, bulkOrListPrecedence: 1, noReplyAddress: 0 }, category: 'potential_newsletter_or_automated', safeToDelete: false },
    { sender: 'a@example.test', count: 1, signals: { listUnsubscribe: 0, bulkOrListPrecedence: 0, noReplyAddress: 0 }, category: 'no_signal', safeToDelete: false },
    { sender: 'no-reply@example.test', count: 1, signals: { listUnsubscribe: 0, bulkOrListPrecedence: 0, noReplyAddress: 1 }, category: 'potential_newsletter_or_automated', safeToDelete: false },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /Synthetic subject|unsubscribe>/);
});

test('metadata failures and configured limit violations surface explicitly', () => {
  assert.throws(() => run('Sender Inventory Report', { all: () => [{ json: { id: 'id1' } }] }), /Unexpected Gmail metadata/);
  assert.throws(() => run('Sender Inventory Report', { all: () => [metadata('id1', []), metadata('id2', [])] }, 1), /exceeds/);
  assert.throws(() => run('Sender Inventory Report', { all: () => [metadata('id1', []), metadata('id1', [])] }), /Unexpected Gmail metadata/);
  assert.throws(() => run('Sender Inventory Report', { all: () => [metadata('id1', [null])] }), /Unexpected Gmail metadata headers/);
});

test('malformed addresses are unknown rather than attributed to a sender', () => {
  const addresses = ['.name@example.test', 'name.@example.test', 'name@example-.test', 'name@-example.test', 'name@example..test', 'first@example.test, Name <second@example.test>'];
  const items = addresses.map((address, i) => metadata(`id${i}`, [header('From', address)]));
  assert.deepEqual(run('Sender Inventory Report', { all: () => items })[0].json,
    { messagesAnalyzed: 6, unknownSenderCount: 6, senders: [] });
});

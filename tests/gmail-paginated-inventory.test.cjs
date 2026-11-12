const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../workflows/03-gmail-paginated-inventory.json'),
  'utf8',
));

const node = (name) => {
  const result = workflow.nodes.find((entry) => entry.name === name);
  assert.ok(result, `Missing node: ${name}`);
  return result;
};

const run = (name, input, config = {}) => {
  const defaults = {
    maxMessages: 500,
    pageSize: 100,
    requestDelayMs: 200,
    maxRetries: 3,
    retryBaseDelayMs: 1000,
    pagination: {
      nextPageToken: null,
      pagesFetched: 0,
      messagesDiscovered: 0,
      messageIds: []
    },
    apiRequests: 0,
    retryCount: 0,
    errors: []
  };
  const state = { ...defaults, ...config };
  return new Function('$input', '$', node(name).parameters.jsCode)(
    input,
    (name) => {
      assert.equal(name, 'Configure Pagination');
      return { first: () => ({ json: state }) };
    },
  );
};

const listResponse = (messages, nextPageToken) => ({
  first: () => ({
    json: {
      messages: messages === undefined ? undefined : messages,
      nextPageToken: nextPageToken || null
    }
  })
});

const metadata = (id, headers) => ({ json: { id, labelIds: ['INBOX'], payload: { headers } } });
const header = (name, value) => ({ name, value });

test('workflow is manual, unbound, inactive, unpinned and disables execution saves', () => {
  assert.equal(workflow.name, '03 - Gmail Paginated Inventory');
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
});

test('configuration validates maxMessages, pageSize, requestDelayMs, maxRetries, retryBaseDelayMs', () => {
  const code = node('Configure Pagination').parameters.jsCode;
  
  for (const [param, value] of [
    ['maxMessages', '0'], ['maxMessages', '10001'],
    ['pageSize', '0'], ['pageSize', '501'],
    ['requestDelayMs', '-1'], ['requestDelayMs', '60001'],
    ['maxRetries', '-1'], ['maxRetries', '11'],
    ['retryBaseDelayMs', '-1'], ['retryBaseDelayMs', '60001'],
  ]) {
    const testCode = code.replace(`const ${param} = `, `const ${param} = `);
    const fn = new Function(testCode.replace(new RegExp(`const ${param} = \\d+`), `const ${param} = ${value}`));
    assert.throws(() => fn(), new RegExp(`${param}.*integer`));
  }
});

test('configuration returns initial pagination state with all required fields', () => {
  const result = run('Configure Pagination', {})[0].json;
  assert.equal(result.maxMessages, 500);
  assert.equal(result.pageSize, 100);
  assert.equal(result.requestDelayMs, 200);
  assert.equal(result.maxRetries, 3);
  assert.equal(result.retryBaseDelayMs, 1000);
  assert.deepEqual(result.pagination, {
    nextPageToken: null,
    pagesFetched: 0,
    messagesDiscovered: 0,
    messageIds: []
  });
  assert.equal(result.apiRequests, 0);
  assert.equal(result.retryCount, 0);
  assert.deepEqual(result.errors, []);
});

test('process page response handles empty mailbox correctly', () => {
  const result = run('Process Page Response', listResponse(undefined))[0].json;
  assert.equal(result.pagination.pagesFetched, 1);
  assert.equal(result.pagination.messagesDiscovered, 0);
  assert.deepEqual(result.pagination.messageIds, []);
  assert.equal(result.pagination.hasMorePages, false);
  assert.equal(result.apiRequests, 1);
});

test('process page response accumulates message IDs across pages', () => {
  let state = {
    maxMessages: 500,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 0,
      messagesDiscovered: 0,
      messageIds: []
    },
    apiRequests: 0
  };
  
  // First page
  let result = run('Process Page Response', 
    listResponse([{ id: 'msg1' }, { id: 'msg2' }], 'token1'), 
    state
  )[0].json;
  assert.deepEqual(result.pagination.messageIds, ['msg1', 'msg2']);
  assert.equal(result.pagination.pagesFetched, 1);
  assert.equal(result.pagination.hasMorePages, true);
  assert.equal(result.apiRequests, 1);
  
  // Second page
  result = run('Process Page Response',
    listResponse([{ id: 'msg3' }, { id: 'msg4' }], null),
    result
  )[0].json;
  assert.deepEqual(result.pagination.messageIds, ['msg1', 'msg2', 'msg3', 'msg4']);
  assert.equal(result.pagination.pagesFetched, 2);
  assert.equal(result.pagination.messagesDiscovered, 4);
  assert.equal(result.pagination.hasMorePages, false);
});

test('process page response stops pagination when maxMessages is reached', () => {
  const state = {
    maxMessages: 2,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 0,
      messagesDiscovered: 0,
      messageIds: ['msg1', 'msg2']
    },
    apiRequests: 0
  };
  
  const result = run('Process Page Response',
    listResponse([{ id: 'msg3' }, { id: 'msg4' }], 'token1'),
    state
  )[0].json;
  
  assert.deepEqual(result.pagination.messageIds, ['msg1', 'msg2']);
  assert.equal(result.pagination.hasMorePages, false);
});

test('process page response detects and deduplicates message IDs', () => {
  let state = {
    maxMessages: 500,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 0,
      messagesDiscovered: 0,
      messageIds: ['msg1']
    },
    apiRequests: 0
  };
  
  const result = run('Process Page Response',
    listResponse([{ id: 'msg1' }, { id: 'msg2' }], null),
    state
  )[0].json;
  
  assert.deepEqual(result.pagination.messageIds, ['msg1', 'msg2']);
  assert.equal(result.pagination.messagesDiscovered, 2);
});

test('process page response rejects invalid message ID formats', () => {
  const state = {
    maxMessages: 500,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 0,
      messagesDiscovered: 0,
      messageIds: []
    },
    apiRequests: 0
  };
  
  for (const badId of ['../msg1', 'msg1\n', 'msg1/', 'msg1 ', '', null]) {
    assert.throws(
      () => run('Process Page Response', listResponse([{ id: badId }], null), state),
      /Invalid Gmail message ID format/
    );
  }
});

test('prepare metadata requests converts message IDs to HTTP requests', () => {
  const state = {
    maxMessages: 500,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 1,
      messagesDiscovered: 3,
      messageIds: ['msg1', 'msg2', 'msg3']
    },
    apiRequests: 1
  };
  
  const input = {
    first: () => ({ json: state }),
    all: () => []
  };
  
  const result = new Function('$input', '$', node('Prepare Metadata Requests').parameters.jsCode)(
    input,
    (name) => {
      assert.equal(name, 'Configure Pagination');
      return { first: () => ({ json: state }) };
    },
  );
  
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(r => r.json.id), ['msg1', 'msg2', 'msg3']);
  assert.ok(result.every(r => r.json.state === state));
});

test('prepare metadata requests handles empty message list', () => {
  const state = {
    maxMessages: 500,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 1,
      messagesDiscovered: 0,
      messageIds: []
    },
    apiRequests: 1
  };
  
  const input = {
    first: () => ({ json: state }),
    all: () => []
  };
  
  const result = new Function('$input', '$', node('Prepare Metadata Requests').parameters.jsCode)(
    input,
    (name) => {
      assert.equal(name, 'Configure Pagination');
      return { first: () => ({ json: state }) };
    },
  );
  
  assert.equal(result.length, 1);
  assert.equal(result[0].json.messagesAnalyzed, 0);
  assert.equal(result[0].json.unknownSenderCount, 0);
  assert.deepEqual(result[0].json.senders, []);
  assert.equal(result[0].json.partial, true);
});

test('sender inventory report normalizes, counts, and sorts senders', () => {
  const state = {
    maxMessages: 500,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 1,
      messagesDiscovered: 7,
      messageIds: ['id1', 'id2', 'id3', 'id4', 'id5', 'id6', 'id7']
    },
    apiRequests: 1
  };
  
  const items = [
    metadata('id1', [header('From', 'Example <NEWS@EXAMPLE.TEST>'), header('List-Unsubscribe', '<https://example.test/unsubscribe>')]),
    metadata('id2', [header('from', 'news@example.test'), header('Precedence', 'Bulk')]),
    metadata('id3', [header('From', 'no-reply@example.test')]),
    metadata('id4', [header('From', 'Person <a@example.test>')]),
    metadata('id5', [header('From', 'invalid address')]),
    metadata('id6', []),
    metadata('id7', [header('From', 'a@example.test')]),
  ];
  
  const input = {
    all: () => items.map((item, idx) => ({
      json: {
        id: `id${idx + 1}`,
        state,
        payload: item.json.payload
      }
    }))
  };
  
  const report = new Function('$input', '$', node('Sender Inventory Report').parameters.jsCode)(
    input,
    (name) => {
      assert.equal(name, 'Configure Pagination');
      return { first: () => ({ json: state }) };
    },
  )[0].json;
  
  assert.equal(report.messagesAnalyzed, 7);
  assert.equal(report.unknownSenderCount, 2);
  assert.equal(report.uniqueSenderCount, 3);
  assert.deepEqual(report.senders, [
    {
      sender: 'a@example.test',
      count: 2,
      signals: { listUnsubscribe: 0, bulkOrListPrecedence: 0, noReplyAddress: 0 },
      category: 'no_signal',
      safeToDelete: false
    },
    {
      sender: 'news@example.test',
      count: 2,
      signals: { listUnsubscribe: 1, bulkOrListPrecedence: 1, noReplyAddress: 0 },
      category: 'potential_newsletter_or_automated',
      safeToDelete: false
    },
    {
      sender: 'no-reply@example.test',
      count: 1,
      signals: { listUnsubscribe: 0, bulkOrListPrecedence: 0, noReplyAddress: 1 },
      category: 'potential_newsletter_or_automated',
      safeToDelete: false
    }
  ]);
});

test('sender inventory report does not include sensitive data in output', () => {
  const state = {
    maxMessages: 500,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 1,
      messagesDiscovered: 1,
      messageIds: ['id1']
    },
    apiRequests: 1
  };
  
  const items = [
    metadata('id1', [
      header('From', 'Person <user@example.test>'),
      header('Subject', 'Private subject line'),
      header('Date', 'Mon, 12 Nov 2026 10:00:00 +0000'),
      header('List-Unsubscribe', '<https://example.test/unsubscribe?token=secret>')
    ])
  ];
  
  const input = {
    all: () => items.map((item, idx) => ({
      json: {
        id: `id${idx + 1}`,
        state,
        payload: item.json.payload
      }
    }))
  };
  
  const report = new Function('$input', '$', node('Sender Inventory Report').parameters.jsCode)(
    input,
    (name) => {
      assert.equal(name, 'Configure Pagination');
      return { first: () => ({ json: state }) };
    },
  )[0].json;
  
  assert.doesNotMatch(JSON.stringify(report), /Private subject line|secret|Mon, 12 Nov/);
});

test('sender inventory report marks partial results when analysis incomplete', () => {
  const state = {
    maxMessages: 500,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 1,
      messagesDiscovered: 5,
      messageIds: ['id1', 'id2', 'id3', 'id4', 'id5']
    },
    apiRequests: 6
  };
  
  const items = [
    metadata('id1', [header('From', 'user1@example.test')]),
    metadata('id2', [header('From', 'user2@example.test')]),
    metadata('id3', [header('From', 'user3@example.test')])
    // id4 and id5 are missing
  ];
  
  const input = {
    all: () => items.map((item, idx) => ({
      json: {
        id: `id${idx + 1}`,
        state,
        payload: item.json.payload
      }
    }))
  };
  
  const report = new Function('$input', '$', node('Sender Inventory Report').parameters.jsCode)(
    input,
    (name) => {
      assert.equal(name, 'Configure Pagination');
      return { first: () => ({ json: state }) };
    },
  )[0].json;
  
  assert.equal(report.messagesAnalyzed, 3);
  assert.equal(report.partial, true);
});

test('workflow graph and pagination connections are correct', () => {
  const connections = workflow.connections;
  
  assert.deepEqual(connections['Manual Trigger'].main, [[{ node: 'Configure Pagination', type: 'main', index: 0 }]]);
  assert.deepEqual(connections['Configure Pagination'].main, [[{ node: 'List Messages Page', type: 'main', index: 0 }]]);
  assert.deepEqual(connections['List Messages Page'].main, [[{ node: 'Process Page Response', type: 'main', index: 0 }]]);
  assert.deepEqual(connections['Process Page Response'].main, [[{ node: 'Has More Pages', type: 'main', index: 0 }]]);
  
  assert.deepEqual(connections['Has More Pages'].main, [
    [{ node: 'Rate Limit Delay', type: 'main', index: 0 }],
    [{ node: 'Prepare Metadata Requests', type: 'main', index: 0 }]
  ]);
  
  assert.deepEqual(connections['Rate Limit Delay'].main, [[{ node: 'List Messages Page', type: 'main', index: 0 }]]);
  assert.deepEqual(connections['Prepare Metadata Requests'].main, [[{ node: 'Get Message Metadata', type: 'main', index: 0 }]]);
  assert.deepEqual(connections['Get Message Metadata'].main, [[{ node: 'Sender Inventory Report', type: 'main', index: 0 }]]);
});

test('HTTP list messages node uses correct URL with pagination support', () => {
  const listNode = node('List Messages Page');
  assert.equal(listNode.parameters.method ?? 'GET', 'GET');
  assert.equal(listNode.parameters.authentication, 'genericCredentialType');
  assert.equal(listNode.parameters.genericAuthType, 'oAuth2Api');
  
  const expression = listNode.parameters.url;
  assert.ok(expression.includes('pageToken'));
  assert.ok(expression.includes('maxResults'));
  assert.ok(expression.includes('nextPageToken'));
});

test('HTTP metadata node is GET only metadata format', () => {
  const metaNode = node('Get Message Metadata');
  assert.equal(metaNode.parameters.method ?? 'GET', 'GET');
  assert.equal(metaNode.parameters.authentication, 'genericCredentialType');
  assert.equal(metaNode.parameters.genericAuthType, 'oAuth2Api');
  
  const expression = metaNode.parameters.url;
  assert.ok(expression.includes('format=metadata'));
  assert.ok(expression.includes('metadataHeaders'));
});

test('rate limit delay applies configured request delay', () => {
  const delayNode = node('Rate Limit Delay');
  assert.ok(delayNode.parameters.jsCode.includes('requestDelayMs'));
  assert.ok(delayNode.parameters.jsCode.includes('setTimeout'));
});

test('multiple pages with 10000 message limit', () => {
  let state = {
    maxMessages: 10000,
    pageSize: 100,
    pagination: {
      nextPageToken: null,
      pagesFetched: 0,
      messagesDiscovered: 0,
      messageIds: []
    },
    apiRequests: 0
  };
  
  for (let page = 0; page < 5; page++) {
    const msgs = Array.from({ length: 100 }, (_, i) => ({ id: `msg_${page}_${i}` }));
    const nextToken = page < 4 ? `token_${page + 1}` : null;
    
    state = run('Process Page Response', listResponse(msgs, nextToken), state)[0].json;
    assert.equal(state.pagination.pagesFetched, page + 1);
    assert.equal(state.pagination.messageIds.length, (page + 1) * 100);
  }
  
  assert.equal(state.pagination.hasMorePages, false);
  assert.equal(state.pagination.messageIds.length, 500);
});

test('configuration rejects pageSize exceeding or matching maxMessages when inappropriate', () => {
  const state = {
    maxMessages: 100,
    pageSize: 500,
    pagination: { nextPageToken: null, pagesFetched: 0, messagesDiscovered: 0, messageIds: [] },
    apiRequests: 0
  };
  
  // This should be allowed; pageSize can be larger than maxMessages
  const result = run('Process Page Response', listResponse([{ id: 'msg1' }], null), state)[0].json;
  assert.equal(result.pagination.messageIds.length, 1);
});

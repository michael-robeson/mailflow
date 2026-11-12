const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const workflowPath = path.join(__dirname, '../workflows/03-gmail-paginated-inventory-item-state.json');
const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const nodes = new Map(workflow.nodes.map((node) => [node.name, node]));

const codeNodeNames = workflow.nodes
  .filter((node) => node.type === 'n8n-nodes-base.code')
  .map((node) => node.name);

function inputContext(items) {
  return {
    all: () => items,
    first: () => items[0],
  };
}

async function runCode(name, items) {
  const node = nodes.get(name);
  assert.ok(node, `Missing Code node: ${name}`);
  assert.equal(node.type, 'n8n-nodes-base.code');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('$input', node.parameters.jsCode);
  return await execute(inputContext(items));
}

function item(json) {
  return { json };
}

function outputExpression(expression, json) {
  const source = expression.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
  return new Function('$json', `return (${source});`)(json);
}

function outgoing(name) {
  return workflow.connections[name]?.main ?? [];
}

function assertCodeNodeOutputsAreArrays() {
  for (const name of codeNodeNames) {
    assert.equal(nodes.get(name).parameters.mode, 'runOnceForAllItems', `${name} must explicitly use all-items mode`);
    assert.match(
      nodes.get(name).parameters.jsCode,
      /return\s+(?:\[\s*\{|[A-Za-z_$][\w$]*\.map\()/,
      `${name} must return n8n item arrays`,
    );
  }
}

async function executeInventory({ maxMessages, pageSize, pages }) {
  let state = (await runCode('Configure Pagination', [item({ maxMessages, pageSize, requestDelayMs: 0 })]))[0].json;
  const observedPageTokens = [];
  const observedPairs = [];

  for (const page of pages) {
    const stateBranch = await runCode('Preserve Page State', [item(state)]);
    const listNode = nodes.get('List Messages Page');
    const url = outputExpression(listNode.parameters.url, state);
    const parsedUrl = new URL(url);
    observedPageTokens.push(parsedUrl.searchParams.get('pageToken'));
    assert.equal(parsedUrl.searchParams.get('maxResults'), String(pageSize));

    const responseBranch = await runCode('Wrap Page Response', [item({
      statusCode: page.statusCode ?? 200,
      body: page.body,
    })]);

    // The exported Merge node is a one-item position join. The loop cannot
    // advance to another page until this pair has been processed.
    assert.equal(stateBranch.length, 1);
    assert.equal(responseBranch.length, 1);
    const mergeNode = nodes.get('Pair Page State and Response');
    assert.equal(mergeNode.parameters.mode, 'combine');
    assert.equal(mergeNode.parameters.combineBy, 'combineByPosition');
    assert.equal(mergeNode.parameters.options.includeUnpaired, false);
    const paired = [{
      json: {
        ...stateBranch[0].json,
        ...responseBranch[0].json,
      },
    }];
    observedPairs.push({
      pageBefore: paired[0].json.pageState.pagination.pagesFetched,
      responseFirstId: paired[0].json.pageResponse.body?.messages?.[0]?.id ?? null,
    });

    state = (await runCode('Process Page Response', paired))[0].json;
    if (!state.pagination.hasMorePages) break;
    state = (await runCode('Rate Limit Delay', [item(state)]))[0].json;
  }

  return { state, observedPageTokens, observedPairs };
}

async function executeSyntheticMetadata(
  state,
  senderForId = () => 'alerts@example.test',
  statusForId = () => 200,
) {
  const prepared = await runCode('Prepare Metadata Requests', [item(state)]);
  assert.ok(prepared.every((entry) => entry.json.requestContext?.state === state));

  if (prepared[0].json.skipMetadata) {
    return (await runCode('Sender Inventory Report', prepared))[0].json;
  }

  const contextBranch = await runCode('Preserve Metadata Context', prepared);
  const responseBranch = await runCode('Wrap Metadata Response', prepared.map((entry) => {
    const id = entry.json.requestContext.id;
    return item({
      statusCode: statusForId(id),
      body: {
        id,
        payload: {
          headers: [
            { name: 'From', value: senderForId(id) },
            { name: 'List-Unsubscribe', value: '<https://example.test/unsubscribe>' },
          ],
        },
      },
    });
  }));
  assert.equal(contextBranch.length, responseBranch.length);
  const paired = contextBranch.map((context, index) => item({
    ...context.json,
    ...responseBranch[index].json,
  }));
  return (await runCode('Sender Inventory Report', paired))[0].json;
}

test('workflow graph has connected pagination and paired-request paths', () => {
  const nodeNames = new Set(workflow.nodes.map((node) => node.name));
  const incoming = new Map([...nodeNames].map((name) => [name, 0]));

  for (const [source, outputs] of Object.entries(workflow.connections)) {
    assert.ok(nodeNames.has(source), `Unknown source node ${source}`);
    for (const branch of outputs.main) {
      for (const edge of branch) {
        assert.ok(nodeNames.has(edge.node), `Unknown destination node ${edge.node}`);
        incoming.set(edge.node, incoming.get(edge.node) + 1);
      }
    }
  }
  for (const node of workflow.nodes) {
    if (node.name !== 'Manual Trigger') assert.ok(incoming.get(node.name) > 0, `${node.name} is disconnected`);
  }

  const pageMergeEdges = [
    ...outgoing('Preserve Page State')[0],
    ...outgoing('Wrap Page Response')[0],
  ];
  assert.deepEqual(pageMergeEdges.map((edge) => [edge.node, edge.index]), [
    ['Pair Page State and Response', 0],
    ['Pair Page State and Response', 1],
  ]);
  assert.deepEqual(outgoing('Rate Limit Delay')[0].map((edge) => edge.node).sort(), [
    'List Messages Page',
    'Preserve Page State',
  ]);
  assert.deepEqual(outgoing('Has More Pages').map((branch) => branch.map((edge) => edge.node)), [
    ['Rate Limit Delay'],
    ['Prepare Metadata Requests'],
  ]);

  for (const name of ['Pair Page State and Response', 'Pair Metadata Context and Response']) {
    const merge = nodes.get(name);
    assert.equal(merge.typeVersion, 3.2);
    assert.equal(merge.parameters.mode, 'combine');
    assert.equal(merge.parameters.combineBy, 'combineByPosition');
    assert.equal(merge.parameters.options.includeUnpaired, false);
  }

  assert.equal(workflow.active, false);
  assert.deepEqual(workflow.pinData, {});
  assertCodeNodeOutputsAreArrays();
});

test('three-page pagination preserves state and uses each prior nextPageToken', async () => {
  const pages = [
    { body: { messages: Array.from({ length: 25 }, (_, i) => ({ id: `page1-${i}` })), nextPageToken: 'token-one' } },
    { body: { messages: Array.from({ length: 25 }, (_, i) => ({ id: `page2-${i}` })), nextPageToken: 'token-two' } },
    { body: { messages: Array.from({ length: 25 }, (_, i) => ({ id: `page3-${i}` })) } },
  ];
  const result = await executeInventory({ maxMessages: 75, pageSize: 25, pages });

  assert.deepEqual(result.observedPageTokens, [null, 'token-one', 'token-two']);
  assert.deepEqual(result.observedPairs.map((pair) => pair.pageBefore), [0, 1, 2]);
  assert.deepEqual(result.observedPairs.map((pair) => pair.responseFirstId), ['page1-0', 'page2-0', 'page3-0']);
  assert.equal(result.state.pagination.pagesFetched, 3);
  assert.equal(result.state.pagination.messagesDiscovered, 75);
  assert.equal(result.state.pagination.messageIds.length, 75);
  assert.equal(new Set(result.state.pagination.messageIds).size, 75);
  assert.equal(result.state.pagination.hasMorePages, false);
  assert.equal(result.state.errors.length, 0);
});

test('50-message controlled-test configuration fetches two 25-message pages and caps metadata requests', async () => {
  const pages = [
    { body: { messages: Array.from({ length: 25 }, (_, i) => ({ id: `test1-${i}` })), nextPageToken: 'next-25' } },
    { body: { messages: Array.from({ length: 25 }, (_, i) => ({ id: `test2-${i}` })), nextPageToken: 'next-50' } },
  ];
  const result = await executeInventory({ maxMessages: 50, pageSize: 25, pages });

  assert.deepEqual(result.observedPageTokens, [null, 'next-25']);
  assert.equal(result.state.pagination.pagesFetched, 2);
  assert.equal(result.state.pagination.messageIds.length, 50);
  assert.equal(result.state.pagination.hasMorePages, false);
  assert.equal(result.state.partial, true, 'stopping at maxMessages with another page available is partial');

  const report = await executeSyntheticMetadata(result.state, () => 'alerts@example.test');
  assert.equal(report.messagesAnalyzed, 50);
  assert.equal(report.unknownSenderCount, 0);
  assert.equal(report.uniqueSenderCount, 1);
  assert.equal(report.senders[0].count, 50);
  assert.equal(report.senders[0].safeToDelete, false);
  assert.equal(report.apiRequests, 52);
});

test('sender parsing normalizes display-name and bare From headers', async () => {
  const result = await executeInventory({
    maxMessages: 2,
    pageSize: 2,
    pages: [{
      body: {
        messages: [{ id: 'sender-one' }, { id: 'sender-two' }],
      },
    }],
  });
  const fromById = new Map([
    ['sender-one', '  Example Sender   <   Alerts@Example.TEST   >  '],
    ['sender-two', '  ALERTS@example.test  '],
  ]);
  const report = await executeSyntheticMetadata(result.state, (id) => fromById.get(id));

  assert.equal(report.messagesAnalyzed, 2);
  assert.equal(report.unknownSenderCount, 0);
  assert.equal(report.uniqueSenderCount, 1);
  assert.equal(report.senders[0].sender, 'alerts@example.test');
  assert.equal(report.senders[0].count, 2);
  assert.equal(report.senders[0].signals.listUnsubscribe, 2);
  assert.equal(report.senders[0].safeToDelete, false);
});

test('maxMessages is an absolute cap when a final page contains extra IDs', async () => {
  const result = await executeInventory({
    maxMessages: 30,
    pageSize: 25,
    pages: [
      { body: { messages: Array.from({ length: 25 }, (_, i) => ({ id: `capped1-${i}` })), nextPageToken: 'cap-token' } },
      { body: { messages: Array.from({ length: 25 }, (_, i) => ({ id: `capped2-${i}` })), nextPageToken: 'more-pages' } },
    ],
  });

  assert.equal(result.state.pagination.pagesFetched, 2);
  assert.equal(result.state.pagination.messageIds.length, 30);
  assert.equal(result.state.pagination.hasMorePages, false);
  assert.equal(result.state.partial, true);
  const report = await executeSyntheticMetadata(result.state);
  assert.equal(report.messagesAnalyzed, 30);
  assert.equal(report.apiRequests, 32);
});

test('deduplicates across pages and stops when a page makes no progress', async () => {
  const result = await executeInventory({
    maxMessages: 50,
    pageSize: 25,
    pages: [
      { body: { messages: Array.from({ length: 25 }, (_, i) => ({ id: `duplicate-${i}` })), nextPageToken: 'token-a' } },
      { body: { messages: Array.from({ length: 25 }, (_, i) => ({ id: `duplicate-${i}` })), nextPageToken: 'token-b' } },
    ],
  });

  assert.equal(result.state.pagination.pagesFetched, 2);
  assert.equal(result.state.pagination.messageIds.length, 25);
  assert.equal(result.state.pagination.hasMorePages, false);
  assert.match(result.state.errors.join(' '), /made no progress/);
  assert.equal(result.state.partial, true);
});

test('handles empty pages and missing continuation tokens as normal termination', async () => {
  for (const body of [{}, { messages: [] }]) {
    const result = await executeInventory({
      maxMessages: 50,
      pageSize: 25,
      pages: [{ body }],
    });
    assert.equal(result.state.pagination.pagesFetched, 1);
    assert.equal(result.state.pagination.messageIds.length, 0);
    assert.equal(result.state.pagination.hasMorePages, false);
    assert.deepEqual(result.state.errors, []);
  }
});

test('records list and metadata HTTP errors without retrying or making Gmail writes', async () => {
  const listFailure = await executeInventory({
    maxMessages: 50,
    pageSize: 25,
    pages: [{ statusCode: 403, body: { error: { status: 'PERMISSION_DENIED' } } }],
  });
  assert.equal(listFailure.state.pagination.hasMorePages, false);
  assert.match(listFailure.state.errors.join(' '), /HTTP 403/);
  assert.equal(listFailure.state.retryCount, 0);

  const report = await executeSyntheticMetadata({
    ...listFailure.state,
    partial: false,
    errors: [],
    pagination: {
      ...listFailure.state.pagination,
      messageIds: ['synthetic-id'],
    },
  }, undefined, () => 401);
  assert.equal(report.messagesAnalyzed, 0);
  assert.match(report.errors.join(' '), /HTTP 401/);
  assert.equal(report.retryCount, 0);

  for (const name of ['List Messages Page', 'Get Message Metadata']) {
    const request = nodes.get(name).parameters;
    assert.equal(request.method, 'GET');
    assert.equal(request.options.response.response.neverError, true);
  }
  for (const node of workflow.nodes.filter((entry) => entry.type === 'n8n-nodes-base.httpRequest')) {
    assert.equal(node.parameters.method, 'GET');
    assert.doesNotMatch(node.parameters.url, /send|delete|modify|trash|archive/i);
  }
});

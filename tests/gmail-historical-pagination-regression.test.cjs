'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../workflows/03-gmail-paginated-inventory.json'), 'utf8'),
);
const nodes = new Map(workflow.nodes.map((node) => [node.name, node]));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('historical pagination carries IDs through three synthetic pages', async () => {
  const pages = [
    { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'one' },
    { messages: [{ id: 'b' }, { id: 'c' }], nextPageToken: 'two' },
    { messages: [{ id: 'd' }] },
  ];
  const outputs = [];
  const requestTokens = [];
  const requestSizes = [];
  const nodeOutputs = new Map();
  const pendingMerge = new Map();
  const queue = [{ name: 'Configure Pagination', items: [{ json: {} }], index: 0 }];
  let pageIndex = 0;
  let metadataItems;

  while (queue.length) {
    const { name, items, index } = queue.shift();
    const node = nodes.get(name);
    assert.ok(node, `Missing node: ${name}`);
    let result;
    let branch = 0;
    if (name === 'List Messages Page') {
      assert.ok(pageIndex < pages.length, 'Unexpected extra list request');
      const expression = node.parameters.url.slice(3, -3);
      const url = new URL(new Function('$json', `return (${expression});`)(items[0].json));
      requestTokens.push(url.searchParams.get('pageToken'));
      requestSizes.push(url.searchParams.get('maxResults'));
      result = [{ json: pages[pageIndex++] }];
    } else if (node.type === 'n8n-nodes-base.merge') {
      assert.equal(node.parameters.mode, 'combine');
      assert.equal(node.parameters.combineBy, 'combineByPosition');
      assert.equal(node.parameters.options.includeUnpaired, false);
      pendingMerge.set(index, items);
      if (pendingMerge.size < 2) continue;
      assert.equal(pendingMerge.get(0).length, 1);
      assert.equal(pendingMerge.get(1).length, 1);
      result = [{ json: { ...pendingMerge.get(0)[0].json, ...pendingMerge.get(1)[0].json } }];
      pendingMerge.clear();
    } else if (name === 'Has More Pages') {
      result = items;
      branch = items[0].json.pagination.hasMorePages ? 0 : 1;
    } else if (name === 'Prepare Metadata Requests') {
      metadataItems = items;
      break;
    } else {
      assert.equal(node.type, 'n8n-nodes-base.code');
      const input = { first: () => items[0], all: () => items };
      const lookup = (nodeName) => ({
        first: () => {
          assert.ok(nodeOutputs.has(nodeName), `Node ${nodeName} has not executed`);
          return nodeOutputs.get(nodeName)[0];
        },
      });
      const code =
        name === 'Configure Pagination'
          ? node.parameters.jsCode.replace(
              'const requestDelayMs = 200;',
              'const requestDelayMs = 0;',
            )
          : node.parameters.jsCode;
      result = await new AsyncFunction('$input', '$', code)(input, lookup);
    }
    nodeOutputs.set(name, result);
    if (name === 'Process Page Response') outputs.push(result[0].json);
    for (const edge of workflow.connections[name]?.main[branch] ?? []) {
      queue.push({ name: edge.node, items: result, index: edge.index });
    }
  }

  assert.deepEqual(requestTokens, [null, 'one', 'two']);
  assert.deepEqual(
    outputs.map((state) => state.pagination.messageIds),
    [
      ['a', 'b'],
      ['a', 'b', 'c'],
      ['a', 'b', 'c', 'd'],
    ],
  );
  assert.deepEqual(requestSizes, ['100', '100', '100']);
  assert.deepEqual(
    outputs.map((state) => state.pagination.pagesFetched),
    [1, 2, 3],
  );
  assert.equal(outputs[2].pagination.messagesDiscovered, 5);
  assert.equal(outputs[2].apiRequests, 3);
  assert.equal(outputs[2].pagination.hasMorePages, false);
  assert.deepEqual(metadataItems[0].json.pagination.messageIds, ['a', 'b', 'c', 'd']);
});

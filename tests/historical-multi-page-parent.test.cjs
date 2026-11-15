'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
  createHistoricalState, prepareHistoricalPage, historicalLoopResult, historicalFinalReport,
} = require('../lib/historical-ingestion.cjs');

const parent = JSON.parse(fs.readFileSync('workflows/09-mailflow-historical-multi-page.json', 'utf8'));
const nodes = new Map(parent.nodes.map((node) => [node.name, node]));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function checkParentReply(requestState, reply, loop = false) {
  const queue = loop
    ? [{ name: 'Next Page State', items: [{ json: { state: requestState } }], index: 0 }]
    : [{ name: 'Has Pending Page', items: [{ json: requestState }], index: 0 }];
  const mergeInputs = new Map();
  let requests = 0;
  while (queue.length) {
    const { name, items, index } = queue.shift();
    const node = nodes.get(name);
    assert.ok(node, `Missing node: ${name}`);
    let result;
    if (name === 'Has Pending Page') {
      assert.equal(items[0].json.hasMore, true);
      result = items;
    } else if (name === 'Run One Page') {
      assert.deepEqual(items[0].json, requestState);
      requests++;
      result = [{ json: reply }];
    } else if (node.type === 'n8n-nodes-base.merge') {
      assert.equal(node.parameters.mode, 'combine');
      assert.equal(node.parameters.combineBy, 'combineByPosition');
      assert.equal(node.parameters.options.includeUnpaired, false);
      mergeInputs.set(index, items);
      if (mergeInputs.size < 2) continue;
      assert.equal(mergeInputs.get(0).length, 1);
      assert.equal(mergeInputs.get(1).length, 1);
      result = [{ json: { ...mergeInputs.get(0)[0].json, ...mergeInputs.get(1)[0].json } }];
      mergeInputs.clear();
    } else {
      assert.equal(node.type, 'n8n-nodes-base.code');
      const input = { first: () => items[0], all: () => items };
      const loadPackage = (name) => {
        assert.equal(name, 'mailflow-pipeline');
        return { historicalLoopResult, historicalFinalReport };
      };
      result = await new AsyncFunction('require', '$input', node.parameters.jsCode)(loadPackage, input);
    }
    if (name === 'Check Page Progress') {
      assert.equal(requests, 1);
      return result[0].json;
    }
    for (const edge of parent.connections[name]?.main[0] ?? []) {
      queue.push({ name: edge.node, items: result, index: edge.index });
    }
  }
  throw new Error('Parent did not check the page reply');
}

test('parent checks normal and stop replies against the current request', async () => {
  const initial = createHistoricalState({
    ingestionId: 'c0000000-0000-4000-8000-000000000001',
    accountKey: 'synthetic_account',
    pageSize: 2,
    maxMessages: 8,
  });
  const first = prepareHistoricalPage(initial, { messages: [{ id: 'a' }], nextPageToken: 'one' }).state;
  const current = prepareHistoricalPage(first, { messages: [{ id: 'b' }], nextPageToken: 'two' }).state;
  const next = prepareHistoricalPage(current, { messages: [{ id: 'c' }], nextPageToken: 'three' }).state;
  const staleReply = { previous: initial, state: first, retryCurrentPage: false };
  assert.equal(historicalLoopResult(staleReply.previous, staleReply).continue, true);

  for (const loop of [false, true]) {
    await assert.rejects(checkParentReply(current, staleReply, loop), /request state/i);
    for (const stopReason of ['list_failure', 'pagination_failure']) {
      await assert.rejects(checkParentReply(current, { previous: initial, stopReason }, loop), /request state/i);
      const result = await checkParentReply(current, { previous: structuredClone(current), stopReason }, loop);
      assert.equal(result.continue, false);
      assert.equal(result.report.pages, 2);
      assert.equal(result.report.stopReason, stopReason);
    }
    const reordered = Object.fromEntries(Object.entries(structuredClone(current)).reverse());
    const result = await checkParentReply(current, {
      previous: reordered, state: next, retryCurrentPage: false,
    }, loop);
    assert.equal(result.continue, true);
    assert.deepEqual(result.state, next);

    const failed = { ...next, failed: current.failed + 1 };
    const retry = await checkParentReply(current, {
      previous: structuredClone(current), state: failed, retryCurrentPage: true,
    }, loop);
    assert.equal(retry.continue, false);
    assert.deepEqual(retry.state, current);
    assert.equal(retry.report.stopReason, 'message_failure');

    const changed = structuredClone(current);
    changed.categoryCounts.synthetic = 1;
    await assert.rejects(checkParentReply(current, { previous: changed, state: next, retryCurrentPage: false }, loop),
      /request state/i);
    await assert.rejects(checkParentReply(current, { stopReason: 'list_failure' }, loop), /request state/i);
  }
});

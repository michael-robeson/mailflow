'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { workflowErrors } = require('../scripts/validate.cjs');
const { processGmailResponse } = require('../lib/gmail-live.cjs');
const {
  createHistoricalState,
  openHistoricalIngestion,
  prepareHistoricalPage,
  persistHistoricalPage,
  saveHistoricalCheckpoint,
  historicalReport,
  historicalLoopResult,
  historicalFinalReport,
  HistoricalPaginationError,
} = require('../lib/historical-ingestion.cjs');

const ingestionId = 'c0000000-0000-4000-8000-000000000001';
const config = { ingestionId, accountKey: 'synthetic_account', pageSize: 2, maxMessages: 5 };
const workflow = JSON.parse(
  fs.readFileSync('workflows/08-mailflow-historical-ingestion.json', 'utf8'),
);

function message(id, number = 1) {
  return processGmailResponse(
    id,
    {
      statusCode: 200,
      body: {
        id,
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Subject', value: 'Job alert' }],
          body: { data: Buffer.from('New jobs matching your preferences.').toString('base64url') },
        },
      },
    },
    number,
  );
}

function fakePool() {
  const runs = new Map();
  const messages = new Map();
  const ingestions = new Map();
  const checkpoints = new Map();
  let failCommit = false;
  let failAfterCommit = false;
  return {
    runs,
    messages,
    checkpoints,
    failNextCommit() {
      failCommit = true;
    },
    failAfterNextCommit() {
      failAfterCommit = true;
    },
    async query(sql, values) {
      if (sql.startsWith('INSERT INTO mailflow.historical_ingestions')) {
        if (!ingestions.has(values[0]))
          ingestions.set(values[0], { account_key: values[1], config_hash: values[2] });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT account_key, config_hash FROM mailflow.historical_ingestions')) {
        return { rows: ingestions.has(values[0]) ? [ingestions.get(values[0])] : [] };
      }
      if (sql.startsWith('SELECT page_number, state FROM mailflow.historical_checkpoints')) {
        const pages = checkpoints.get(values[0]) ?? [];
        return { rows: pages.length ? [pages[pages.length - 1]] : [] };
      }
      if (sql.startsWith('INSERT INTO mailflow.historical_checkpoints')) {
        const pages = checkpoints.get(values[0]) ?? [];
        if (pages.some((page) => page.page_number === values[1])) return { rows: [] };
        pages.push({ page_number: values[1], state: values[2] });
        checkpoints.set(values[0], pages);
        return { rows: [{ page_number: values[1] }] };
      }
      assert.match(sql, /SELECT c.category, p.action/);
      const record = runs.get(values[0]);
      return { rows: record && record.accountKey === values[1] ? [record] : [] };
    },
    async connect() {
      let pending;
      return {
        async query(sql, values) {
          if (sql === 'BEGIN') return { rows: [] };
          if (sql === 'ROLLBACK') {
            pending = undefined;
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            if (failCommit) {
              failCommit = false;
              throw new Error('synthetic commit failure');
            }
            if (pending) {
              runs.set(pending.runId, pending);
              messages.set(pending.messageId, pending.messageId);
            }
            if (failAfterCommit) {
              failAfterCommit = false;
              throw new Error('synthetic uncertain commit');
            }
            return { rows: [] };
          }
          if (sql.startsWith('INSERT INTO mailflow.workflow_runs')) {
            const existing = runs.get(values[0]);
            if (existing) return { rows: [] };
            pending = { runId: values[0], accountKey: values[1], hash: values[2] };
            return { rows: [{ id: values[0] }] };
          }
          if (sql.startsWith('SELECT account_key, batch_hash')) {
            const existing = runs.get(values[0]);
            return {
              rows: existing
                ? [{ account_key: existing.accountKey, batch_hash: existing.hash }]
                : [],
            };
          }
          if (sql.startsWith('INSERT INTO mailflow.messages')) {
            pending.messageId = values[1];
            return { rows: [] };
          }
          if (sql.startsWith('SELECT id FROM mailflow.messages'))
            return { rows: [{ id: pending.messageId }] };
          if (sql.startsWith('INSERT INTO mailflow.classifications')) {
            pending.category = values[3];
            return { rows: [{ id: 1 }] };
          }
          if (sql.startsWith('INSERT INTO mailflow.policy_decisions')) {
            pending.action = values[1];
            return { rows: [] };
          }
          throw new Error('Unexpected synthetic query');
        },
        release() {},
      };
    },
  };
}

test('historical workflow is inactive, manual, unbound, bounded and GET-only', async () => {
  assert.equal(workflow.active, false);
  assert.deepEqual(workflow.pinData, {});
  assert.deepEqual(workflowErrors(workflow), []);
  assert.equal(workflow.settings.saveManualExecutions, false);
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveExecutionProgress, false);
  assert.deepEqual([...new Set(workflow.nodes.map((node) => node.type))].sort(), [
    'n8n-nodes-base.code',
    'n8n-nodes-base.httpRequest',
    'n8n-nodes-base.if',
    'n8n-nodes-base.manualTrigger',
  ]);
  const requests = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((node) => node.parameters.method === 'GET' && !node.credentials));
  assert.equal(workflow.connections['Process and Persist Page'], undefined);
  assert.equal(workflow.connections['Empty Page'], undefined);
  assert.deepEqual(
    workflow.connections['Has Pending Page'].main.map((route) => route[0].node),
    ['Request Page', 'Already Complete Report'],
  );
  const code = workflow.nodes.find((node) => node.name === 'Configure Historical Ingestion')
    .parameters.jsCode;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const loadPackage = (name) => {
    assert.equal(name, 'mailflow-pipeline');
    return { createHistoricalState };
  };
  await assert.rejects(new AsyncFunction('require', code)(loadPackage), /ingestion UUID/);
  assert.match(code, /const accountKey = ''/);
});

test('workflow code carries synthetic checkpoint state across manual page executions', async () => {
  const pool = fakePool();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const code = (name) => workflow.nodes.find((node) => node.name === name).parameters.jsCode;
  const loadPackage = (name) => {
    assert.equal(name, 'mailflow-pipeline');
    return {
      prepareHistoricalPage,
      processGmailResponse,
      persistHistoricalForN8n: async (state, processed) => {
        const result = await persistHistoricalPage(pool, state, processed);
        await saveHistoricalCheckpoint(pool, result);
        return historicalReport(result);
      },
    };
  };
  const history = { 'Request Page': [], 'Prepare Page': [], 'Expand Messages': [] };
  const lookup = (name) => ({
    first: () => history[name].at(-1)[0],
    all: () => history[name].at(-1),
  });
  let report;
  for (const [ids, token] of [
    [['a', 'b'], 'next'],
    [['c'], undefined],
  ]) {
    const state = await openHistoricalIngestion(pool, config);
    history['Request Page'].push([{ json: state }]);
    const list = {
      messages: ids.map((id) => ({ id })),
      ...(token ? { nextPageToken: token } : {}),
    };
    const inputPage = { first: () => ({ json: list }) };
    const prepared = await new AsyncFunction('require', '$', '$input', code('Prepare Page'))(
      loadPackage,
      lookup,
      inputPage,
    );
    history['Prepare Page'].push(prepared);
    const expanded = await new AsyncFunction('$input', code('Expand Messages'))({
      first: () => prepared[0],
    });
    history['Expand Messages'].push(expanded);
    const responses = ids.map((id, item) => ({
      pairedItem: { item },
      json: {
        statusCode: 200,
        body: { id, payload: { headers: [] } },
      },
    }));
    const output = await new AsyncFunction(
      'require',
      '$',
      '$input',
      code('Process and Persist Page'),
    )(loadPackage, lookup, { all: () => responses });
    report = output[0].json;
  }
  assert.equal(report.discovered, 3);
  assert.equal(report.persisted, 3);
  assert.equal(report.pages, 2);
  assert.equal(report.hasMore, false);
  assert.equal(pool.runs.size, 3);
});

test('configuration and pagination reject invalid limits, cycles, oversized and stalled pages', () => {
  for (const changes of [
    { ingestionId: '' },
    { accountKey: '' },
    { pageSize: 26 },
    { maxMessages: 1001 },
    { pageSize: 0 },
    { query: 1 },
  ]) {
    assert.throws(() => createHistoricalState({ ...config, ...changes }));
  }
  let state = createHistoricalState(config);
  assert.throws(
    () => prepareHistoricalPage(state, { messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
    /oversized/,
  );
  assert.throws(
    () => prepareHistoricalPage(state, { messages: [], nextPageToken: 'next' }),
    /no progress/,
  );
  state = prepareHistoricalPage(state, { messages: [{ id: 'a' }], nextPageToken: 'one' }).state;
  state = prepareHistoricalPage(state, { messages: [{ id: 'b' }], nextPageToken: 'two' }).state;
  assert.throws(
    () => prepareHistoricalPage(state, { messages: [{ id: 'c' }], nextPageToken: 'one' }),
    /Repeated/,
  );
  assert.throws(
    () => prepareHistoricalPage(state, { messages: [{ id: 'c' }], nextPageToken: '' }),
    /token/,
  );
});

test('pages persist incrementally, stop at the cap, and report only sanitized counts', async () => {
  const pool = fakePool();
  let state = createHistoricalState(config);
  for (const [ids, token] of [
    [['a', 'b'], 'one'],
    [['c', 'd'], 'two'],
    [['e'], 'three'],
  ]) {
    const page = prepareHistoricalPage(state, {
      messages: ids.map((id) => ({ id })),
      nextPageToken: token,
    });
    state = await persistHistoricalPage(
      pool,
      page.state,
      ids.map((id, i) => message(id, i + 1)),
    );
    assert.equal(pool.runs.size, state.persisted);
  }
  assert.equal(state.hasMore, false);
  assert.deepEqual(historicalReport(state), {
    pages: 3,
    discovered: 5,
    processed: 5,
    persisted: 5,
    previouslyProcessed: 0,
    failed: 0,
    categoryCounts: { job_alert: 5 },
    actionCounts: { weekly: 5 },
    stoppedAtLimit: true,
    hasMore: false,
    retryCurrentPage: false,
  });
  assert.ok(!JSON.stringify(historicalReport(state)).includes(ingestionId));
  assert.throws(() => prepareHistoricalPage(state, {}), /completed/);
});

test('restart skips committed messages despite changed pages and retries failures', async () => {
  const pool = fakePool();
  let state = createHistoricalState(config);
  let page = prepareHistoricalPage(state, {
    messages: [{ id: 'a' }, { id: 'b' }],
    nextPageToken: 'next',
  });
  state = await persistHistoricalPage(pool, page.state, [
    message('a'),
    processGmailResponse('b', { statusCode: 404 }, 2),
  ]);
  assert.equal(state.persisted, 1);
  assert.equal(state.failed, 1);
  state = createHistoricalState(config);
  page = prepareHistoricalPage(state, { messages: [{ id: 'b' }, { id: 'a' }] });
  state = await persistHistoricalPage(pool, page.state, [message('b'), message('a', 2)]);
  assert.equal(state.persisted, 1);
  assert.equal(state.previouslyProcessed, 1);
  assert.equal(state.failed, 0);
  assert.equal(pool.runs.size, 2);
  const other = createHistoricalState({
    ...config,
    ingestionId: 'c0000000-0000-4000-8000-000000000002',
  });
  await persistHistoricalPage(pool, other, [message('a')]);
  assert.equal(pool.runs.size, 3);
  assert.equal(pool.messages.size, 2);
});

test('partial commit failures surface and already committed messages are not duplicated on restart', async () => {
  const pool = fakePool();
  const state = createHistoricalState(config);
  await persistHistoricalPage(pool, state, [message('a')]);
  pool.failNextCommit();
  await assert.rejects(
    persistHistoricalPage(pool, state, [message('a'), message('b', 2)]),
    /commit failure/,
  );
  assert.equal(pool.runs.size, 1);
  const retry = await persistHistoricalPage(pool, state, [message('a'), message('b', 2)]);
  assert.equal(retry.previouslyProcessed, 1);
  assert.equal(retry.persisted, 1);
  assert.equal(pool.runs.size, 2);
});

test('uncertain successful commit is recognized on restart without reclassifying', async () => {
  const pool = fakePool();
  const state = createHistoricalState(config);
  pool.failAfterNextCommit();
  await assert.rejects(persistHistoricalPage(pool, state, [message('a')]), /uncertain commit/);
  assert.equal(pool.runs.size, 1);
  const retry = await persistHistoricalPage(pool, state, [
    processGmailResponse('a', { statusCode: 404 }, 1),
  ]);
  assert.equal(retry.previouslyProcessed, 1);
  assert.equal(retry.failed, 0);
  assert.equal(pool.runs.size, 1);
});

test('incomplete prior records fail explicitly', async () => {
  const pool = fakePool();
  const state = createHistoricalState(config);
  await persistHistoricalPage(pool, state, [message('a')]);
  [...pool.runs.values()][0].action = null;
  await assert.rejects(persistHistoricalPage(pool, state, [message('a')]), /Incomplete/);
});

test('checkpoints bind configuration and only advance after a successful page', async () => {
  const pool = fakePool();
  let state = await openHistoricalIngestion(pool, config);
  const first = prepareHistoricalPage(state, {
    messages: [{ id: 'a' }, { id: 'b' }],
    nextPageToken: 'next',
  });
  const failed = await persistHistoricalPage(pool, first.state, [
    message('a'),
    processGmailResponse('b', { statusCode: 404 }, 2),
  ]);
  await assert.rejects(saveHistoricalCheckpoint(pool, failed), /failed messages/);
  state = await openHistoricalIngestion(pool, config);
  assert.equal(state.pages, 0);
  const retry = prepareHistoricalPage(state, {
    messages: [{ id: 'a' }, { id: 'b' }],
    nextPageToken: 'next',
  });
  const completed = await persistHistoricalPage(pool, retry.state, [message('a'), message('b', 2)]);
  assert.equal(completed.previouslyProcessed, 1);
  await saveHistoricalCheckpoint(pool, completed);
  const saved = pool.checkpoints.get(config.ingestionId)[0].state;
  assert.ok(!JSON.stringify(saved).includes(config.ingestionId));
  assert.ok(!JSON.stringify(saved).includes(config.accountKey));
  assert.ok(!Object.hasOwn(saved, 'query'));
  await assert.rejects(saveHistoricalCheckpoint(pool, completed), /already exists/);
  state = await openHistoricalIngestion(pool, config);
  assert.equal(state.pages, 1);
  assert.equal(state.nextPageToken, 'next');
  await assert.rejects(
    openHistoricalIngestion(pool, { ...config, query: 'changed' }),
    /different configuration/,
  );
});

test('multi-page exports are inactive, unbound and isolate each page in a child workflow', () => {
  const parent = JSON.parse(
    fs.readFileSync('workflows/09-mailflow-historical-multi-page.json', 'utf8'),
  );
  const child = JSON.parse(
    fs.readFileSync('workflows/09-mailflow-historical-one-page.json', 'utf8'),
  );
  for (const candidate of [parent, child]) {
    assert.deepEqual(workflowErrors(candidate), []);
    assert.equal(candidate.settings.saveManualExecutions, false);
    assert.equal(candidate.settings.saveDataErrorExecution, 'none');
    assert.equal(candidate.settings.saveDataSuccessExecution, 'none');
    assert.equal(candidate.settings.saveExecutionProgress, false);
  }
  assert.deepEqual(
    parent.nodes.filter((node) => node.type.endsWith('Trigger')).map((node) => node.type),
    ['n8n-nodes-base.manualTrigger'],
  );
  const call = parent.nodes.find((node) => node.name === 'Run One Page');
  assert.equal(call.parameters.source, 'parameter');
  assert.equal(call.parameters.workflowJson, '');
  assert.equal(call.parameters.options.waitForSubWorkflow, true);
  assert.deepEqual(
    child.nodes.filter((node) => node.type.endsWith('Trigger')).map((node) => node.type),
    ['n8n-nodes-base.executeWorkflowTrigger'],
  );
  const requests = child.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((node) => node.parameters.method === 'GET' && !node.credentials));
  const code = parent.nodes.find((node) => node.name === 'Configure Ingestion').parameters.jsCode;
  assert.match(code, /const ingestionId = ''/);
  assert.match(code, /const accountKey = ''/);
  assert.match(code, /const query = ''/);
});

test('multi-page loop checkpoints before requesting the next page and stops at the limit', async () => {
  const pool = fakePool();
  let state = await openHistoricalIngestion(pool, config);
  const pages = [
    [['a', 'b'], 'one'],
    [['c', 'd'], 'two'],
    [['e'], 'three'],
  ];
  let step;
  for (const [ids, token] of pages) {
    assert.equal((pool.checkpoints.get(config.ingestionId) ?? []).length, state.pages);
    const previous = state;
    const page = prepareHistoricalPage(previous, {
      messages: ids.map((id) => ({ id })),
      nextPageToken: token,
    });
    const completed = await persistHistoricalPage(
      pool,
      page.state,
      ids.map((id) => message(id)),
    );
    await saveHistoricalCheckpoint(pool, completed);
    step = historicalLoopResult(previous, { state: completed, retryCurrentPage: false });
    state = step.state;
  }
  assert.equal(step.continue, false);
  assert.equal(step.report.stopReason, 'limit');
  assert.equal(step.report.pages, 3);
  assert.equal(step.report.persisted, 5);
  assert.equal(pool.checkpoints.get(config.ingestionId).length, 3);
  assert.ok(!JSON.stringify(step.report).includes(config.ingestionId));
});

test('multi-page loop resumes after interruption, reports failures and retries without duplicate histories', async () => {
  const pool = fakePool();
  let previous = await openHistoricalIngestion(pool, config);
  let page = prepareHistoricalPage(previous, { messages: [{ id: 'a' }], nextPageToken: 'one' });
  let completed = await persistHistoricalPage(pool, page.state, [message('a')]);
  await saveHistoricalCheckpoint(pool, completed);
  previous = await openHistoricalIngestion(pool, config);
  page = prepareHistoricalPage(previous, { messages: [{ id: 'b' }, { id: 'c' }] });
  completed = await persistHistoricalPage(pool, page.state, [
    message('b'),
    processGmailResponse('c', { statusCode: 404 }, 2),
  ]);
  const failed = historicalLoopResult(previous, { state: completed, retryCurrentPage: true });
  assert.equal(failed.report.stopReason, 'message_failure');
  assert.equal(failed.report.pages, 1);
  assert.equal(failed.report.failed, 1);
  assert.equal(failed.report.stoppedAtLimit, false);
  assert.equal(failed.report.hasMore, true);
  assert.equal(pool.checkpoints.get(config.ingestionId).length, 1);
  previous = await openHistoricalIngestion(pool, config);
  page = prepareHistoricalPage(previous, { messages: [{ id: 'b' }, { id: 'c' }] });
  completed = await persistHistoricalPage(pool, page.state, [message('b'), message('c')]);
  await saveHistoricalCheckpoint(pool, completed);
  const resumed = historicalLoopResult(previous, { state: completed, retryCurrentPage: false });
  assert.equal(resumed.report.stopReason, 'exhausted');
  assert.equal(resumed.report.previouslyProcessed, 1);
  assert.equal(resumed.report.pages, 2);
  assert.equal(pool.runs.size, 3);
  assert.equal(historicalFinalReport(previous, 'list_failure').stopReason, 'list_failure');
});

test('one-page workflow returns sanitized list and pagination failures without checkpointing', async () => {
  const child = JSON.parse(
    fs.readFileSync('workflows/09-mailflow-historical-one-page.json', 'utf8'),
  );
  const code = child.nodes.find((node) => node.name === 'Prepare Page').parameters.jsCode;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const prepare = new AsyncFunction('require', '$', '$input', code);
  const loadPackage = () => ({ prepareHistoricalPage, HistoricalPaginationError });
  let state = createHistoricalState(config);
  const run = (response) =>
    prepare(loadPackage, () => ({ first: () => ({ json: state }) }), {
      first: () => ({ json: response }),
    });
  assert.equal(
    (await run({ error: 'synthetic network error' }))[0].json.stopReason,
    'list_failure',
  );
  assert.equal(
    (await run({ messages: [], nextPageToken: 'stalled' }))[0].json.stopReason,
    'pagination_failure',
  );
  state = prepareHistoricalPage(state, { messages: [{ id: 'a' }], nextPageToken: 'repeat' }).state;
  const repeated = (await run({ messages: [{ id: 'b' }], nextPageToken: 'repeat' }))[0].json;
  assert.equal(repeated.stopReason, 'pagination_failure');
  assert.equal(historicalFinalReport(repeated.previous, repeated.stopReason).pages, 1);
  const malformed = (await run({ messages: 'not-an-array' }))[0].json;
  assert.equal(malformed.stopReason, 'pagination_failure');
  assert.ok(
    !JSON.stringify(historicalFinalReport(malformed.previous, malformed.stopReason)).includes(
      'repeat',
    ),
  );
});

test('multi-page progress guard rejects stale, changed and failed states', () => {
  const previous = createHistoricalState(config);
  const page = prepareHistoricalPage(previous, {
    messages: [{ id: 'a' }],
    nextPageToken: 'one',
  }).state;
  assert.throws(
    () => historicalLoopResult(previous, { state: previous, retryCurrentPage: false }),
    /no progress/,
  );
  assert.throws(
    () =>
      historicalLoopResult(previous, {
        state: { ...page, accountKey: 'other' },
        retryCurrentPage: false,
      }),
    /configuration/,
  );
  assert.throws(
    () =>
      historicalLoopResult(previous, { state: { ...page, failed: 1 }, retryCurrentPage: false }),
    /Failed page/,
  );
  assert.throws(
    () =>
      historicalLoopResult(previous, {
        state: { ...page, discovered: NaN },
        retryCurrentPage: false,
      }),
    /no progress/,
  );
  assert.throws(
    () =>
      historicalLoopResult(previous, {
        state: { ...page, hasMore: false },
        retryCurrentPage: false,
      }),
    /pagination state/,
  );
  assert.throws(
    () =>
      historicalLoopResult(previous, {
        state: { ...page, seenPageTokens: [] },
        retryCurrentPage: false,
      }),
    /pagination state/,
  );
  assert.throws(
    () => historicalLoopResult(previous, { state: page, retryCurrentPage: true }),
    /retry state/,
  );
  assert.throws(() => historicalFinalReport(previous), /pending/);
});

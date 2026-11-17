'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { workflowErrors, secretErrors } = require('../scripts/validate.cjs');
const {
  cleanupRuntime,
  configureWorkflows,
  createVerificationSql,
  prepareRuntime,
  resolveRuntimeDirectory,
} = require('../scripts/prepare-workflow-09-runtime.cjs');
const {
  assertProjectOwned,
  assertProjectUnused,
  resolveProject,
} = require('../scripts/verify-workflow-09-compose-project.cjs');
const { createServer } = require('./runtime/workflow-09/gmail-fixture.cjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function executeProcessAndPersistPage({ state, requests, responses }) {
  const { child } = configureWorkflows({
    ingestionId: '00000000-0000-4000-8000-000000000001',
    accountKey: 'w09_synthetic_test',
  });
  const code = child.nodes.find((node) => node.name === 'Process and Persist Page').parameters
    .jsCode;
  const calls = [];
  const requireStub = (name) => {
    assert.equal(name, 'mailflow-pipeline');
    return {
      processGmailResponse: (id, response, index) => ({
        messageId: id,
        decision: { status: response.status ?? 'decided' },
        index,
      }),
      persistVersionedHistoricalMessagesForN8n: async (actualState, messages) => {
        calls.push({ type: 'm1', state: actualState, messages });
        return { count: messages.length, alreadyProcessed: 0 };
      },
      persistHistoricalPageForN8n: async (actualState, processed) => {
        calls.push({ type: 'v1', state: actualState, processed });
        return { state: actualState, retryCurrentPage: false };
      },
    };
  };
  const lookup = (name) => {
    if (name === 'Prepare Page') return { first: () => ({ json: { state, previous: 'cursor' } }) };
    if (name === 'Expand Messages') return { all: () => requests };
    throw new Error(`Unexpected workflow node lookup: ${name}`);
  };
  const input = { all: () => responses };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const output = await new AsyncFunction('require', '$', '$input', code)(
    requireStub,
    lookup,
    input,
  );
  return { calls, output };
}

test('synthetic Gmail fixture serves the three pages and five full messages in order', async (t) => {
  const events = [];
  const server = createServer({ onEvent: (event) => events.push(event) });
  const port = await listen(server);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}/gmail/v1/users/me/messages`;

  const tokens = ['', 'w09_page_2', 'w09_page_3'];
  const expectedIds = [
    ['w09_msg_001', 'w09_msg_002'],
    ['w09_msg_003', 'w09_msg_004'],
    ['w09_msg_005'],
  ];
  for (let page = 0; page < tokens.length; page++) {
    const url = new URL(base);
    url.searchParams.set('maxResults', '2');
    if (tokens[page]) url.searchParams.set('pageToken', tokens[page]);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.messages.map(({ id }) => id),
      expectedIds[page],
    );
    if (page < 2) assert.equal(body.nextPageToken, `w09_page_${page + 2}`);
    else assert.equal(Object.hasOwn(body, 'nextPageToken'), false);

    for (const { id } of body.messages) {
      const detail = await fetch(`${base}/${id}?format=full`);
      assert.equal(detail.status, 200);
      const message = await detail.json();
      assert.equal(message.id, id);
      assert.equal(message.payload.headers[0].value, 'Job alert');
      assert.equal(
        Buffer.from(message.payload.body.data, 'base64url').toString(),
        'New jobs matching your preferences.',
      );
    }

    const checkpoint = await fetch(`http://127.0.0.1:${port}/checkpoint?pageNumber=${page + 1}`);
    assert.equal(checkpoint.status, 200);
  }

  assert.deepEqual(
    events.filter(({ type }) => type === 'list').map(({ pageToken }) => pageToken),
    [null, 'w09_page_2', 'w09_page_3'],
  );
  assert.deepEqual(
    events
      .filter(({ type }) => ['list', 'checkpoint'].includes(type))
      .map(({ type, pageToken, pageNumber }) =>
        type === 'list' ? `list:${pageToken ?? 'first'}` : `checkpoint:${pageNumber}`,
      ),
    [
      'list:first',
      'checkpoint:1',
      'list:w09_page_2',
      'checkpoint:2',
      'list:w09_page_3',
      'checkpoint:3',
    ],
  );
  assert.equal(events.filter(({ type }) => type === 'message').length, 5);
  assert.ok(
    events.every(
      ({ receivedAtMs, sequence }) => Number.isInteger(receivedAtMs) && Number.isInteger(sequence),
    ),
  );
});

test('synthetic Gmail fixture refuses a next page until the prior checkpoint marker', async (t) => {
  const server = createServer({ onEvent: () => {} });
  const port = await listen(server);
  t.after(() => server.close());
  const listUrl = `http://127.0.0.1:${port}/gmail/v1/users/me/messages?maxResults=2`;

  assert.equal((await fetch(`${listUrl}&pageToken=w09_page_2`)).status, 400);
  assert.equal((await fetch(listUrl)).status, 200);
  assert.equal((await fetch(`${listUrl}&pageToken=w09_page_2`)).status, 409);
  assert.equal((await fetch(`http://127.0.0.1:${port}/checkpoint?pageNumber=1`)).status, 200);
  assert.equal((await fetch(`${listUrl}&pageToken=w09_page_2`)).status, 200);
});

test('temporary workflows preserve the child call, use only the local fixture, and remain inactive', () => {
  const { parent, child } = configureWorkflows({
    ingestionId: '00000000-0000-4000-8000-000000000001',
    accountKey: 'w09_synthetic_test',
  });
  const call = parent.nodes.find((node) => node.name === 'Run One Page');
  const embeddedChild = JSON.parse(call.parameters.workflowJson);
  const httpNodes = child.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest');

  assert.equal(parent.active, false);
  assert.equal(child.active, false);
  assert.equal(call.parameters.source, 'parameter');
  assert.equal(call.parameters.options.waitForSubWorkflow, true);
  assert.deepEqual(embeddedChild, child);
  assert.equal(embeddedChild.name, child.name);
  assert.equal(httpNodes.length, 3);
  assert.ok(
    httpNodes.every(
      (node) =>
        node.parameters.method === 'GET' &&
        node.parameters.url.includes('http://w09-gmail-mock:8080/'),
    ),
  );
  const probe = child.nodes.find((node) => node.name === 'Record Page Checkpoint');
  const returnPage = child.nodes.find((node) => node.name === 'Return Persisted Page');
  assert.ok(
    child.connections['Process and Persist Page'].main[0].some(
      ({ node }) => node === 'Record Page Checkpoint',
    ),
  );
  assert.ok(
    child.connections['Record Page Checkpoint'].main[0].some(
      ({ node }) => node === 'Return Persisted Page',
    ),
  );
  assert.match(probe.parameters.url, /checkpoint\?pageNumber=/);
  assert.match(returnPage.parameters.jsCode, /Process and Persist Page/);
  assert.ok(
    httpNodes.every(
      (node) =>
        !node.parameters.authentication && !node.parameters.genericAuthType && !node.credentials,
    ),
  );
  assert.doesNotMatch(
    JSON.stringify({ parent, child }),
    /gmail\.googleapis\.com|oAuth2Api|"credentials"/i,
  );
  for (const workflow of [parent, child]) {
    assert.equal(workflow.settings.saveDataErrorExecution, 'none');
    assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
    assert.equal(workflow.settings.saveManualExecutions, false);
    assert.equal(workflow.settings.saveExecutionProgress, false);
  }
  assert.deepEqual(workflowErrors(parent), []);
  assert.deepEqual(workflowErrors(child), []);
  assert.deepEqual(secretErrors('parent.json', JSON.stringify(parent)), []);
  assert.deepEqual(secretErrors('child.json', JSON.stringify(child)), []);

  const configureCode = parent.nodes.find((node) => node.name === 'Configure Ingestion').parameters
    .jsCode;
  assert.match(configureCode, /const pageSize = 2/);
  assert.match(configureCode, /const maxMessages = 10/);
  assert.match(configureCode, /const enableM1 = false/);
  assert.match(configureCode, /const configurationRevisionId = null/);
  const enabled = configureWorkflows({
    ingestionId: '00000000-0000-4000-8000-000000000001',
    accountKey: 'w09_synthetic_test',
    enableM1: true,
    configurationRevisionId: 9,
  });
  const enabledCode = enabled.parent.nodes.find((node) => node.name === 'Configure Ingestion')
    .parameters.jsCode;
  assert.match(enabledCode, /const enableM1 = true/);
  assert.match(enabledCode, /const configurationRevisionId = 9/);
  assert.throws(
    () =>
      configureWorkflows({
        ingestionId: '00000000-0000-4000-8000-000000000001',
        accountKey: 'w09_synthetic_test',
        configurationRevisionId: 9,
      }),
    /requires explicit M1 enablement/,
  );
});

test('workflow 09 only invokes versioned evaluation when explicitly enabled', async () => {
  const state = {
    pageSize: 2,
    versionedEvaluation: { enabled: true, configurationRevisionId: null },
  };
  const requests = [{ json: { id: 'm1' } }, { json: { id: 'm2' } }];
  const responses = [
    { pairedItem: { item: 1 }, json: { status: 'decided', body: { id: 'm2' } } },
    { pairedItem: { item: 0 }, json: { status: 'retrieval_error', body: null } },
  ];

  const m1Result = await executeProcessAndPersistPage({ state, requests, responses });
  assert.deepEqual(
    m1Result.calls.map(({ type }) => type),
    ['m1', 'v1'],
  );
  assert.deepEqual(m1Result.calls[0].messages, [{ id: 'm2' }]);
  assert.equal(m1Result.calls[0].state, state);
  assert.equal(m1Result.calls[1].state, state);
  assert.equal(m1Result.output[0].json.previous, 'cursor');
  assert.deepEqual(
    m1Result.calls[1].processed.map(({ messageId }) => messageId),
    ['m1', 'm2'],
  );

  const v1Result = await executeProcessAndPersistPage({
    state: { pageSize: 2, versionedEvaluation: null },
    requests,
    responses,
  });
  assert.deepEqual(
    v1Result.calls.map(({ type }) => type),
    ['v1'],
  );
});

test('success evidence asserts three ordered checkpoints and five unique decisions', () => {
  const sql = createVerificationSql({
    ingestionId: '00000000-0000-4000-8000-000000000001',
    accountKey: 'w09_synthetic_test',
  });
  assert.match(sql, /checkpoint_count <> 3/);
  assert.match(sql, /final_state->>'discovered' <> '5'/);
  assert.match(sql, /final_state->>'persisted' <> '5'/);
  assert.match(sql, /run_count <> 5 OR message_count <> 5/);
  assert.match(sql, /classification_count <> 5 OR decision_count <> 5/);
  assert.match(sql, /versioned_evaluation_count <> 5 OR historical_evaluation_count <> 5/);
  assert.match(sql, /current_effective_count <> 0 OR tag_assignment_count <> 5/);
  assert.match(sql, /policy->>'action' <> 'weekly'/);
  assert.match(sql, /t\.tag_id <> \(e\.classification->>'category'\)/);
  assert.match(sql, /t\.provenance_type <> 'built_in_rule'/);
  assert.match(sql, /is_historical_replay/);
  assert.match(sql, /final_state->'nextPageToken' <> 'null'::jsonb/);
  assert.doesNotMatch(sql, /AS\s+next_page_token/i);
});

test('runtime preparation keeps secrets and workflow copies in a private temp directory', (t) => {
  const { runtimeDir, projectName } = prepareRuntime();
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const hostUid = process.getuid();
  const hostGid = process.getgid();
  const runtimeEnv = fs.readFileSync(path.join(runtimeDir, 'compose.env'), 'utf8');
  assert.equal(path.dirname(runtimeDir), fs.realpathSync(os.tmpdir()));
  assert.match(projectName, /^mailflow-w09-[a-f0-9]{12}$/);
  assert.match(runtimeEnv, new RegExp(`^W09_RUNTIME_UID=${hostUid}$`, 'm'));
  assert.match(runtimeEnv, new RegExp(`^W09_RUNTIME_GID=${hostGid}$`, 'm'));
  for (const directory of ['', 'app-secret', 'package']) {
    const stat = fs.statSync(path.join(runtimeDir, directory));
    assert.equal(stat.mode & 0o777, 0o700, directory || 'runtime directory');
    assert.equal(stat.uid, hostUid, directory || 'runtime directory');
    assert.equal(stat.gid, hostGid, directory || 'runtime directory');
  }
  for (const filename of ['compose.env', 'app-bootstrap.sql', 'app-secret/app-password']) {
    assert.equal(fs.statSync(path.join(runtimeDir, filename)).mode & 0o777, 0o600, filename);
  }
  for (const filename of [
    'compose.env',
    'app-bootstrap.sql',
    'app-secret/app-password',
    'workflows/parent.json',
    'workflows/child.json',
  ]) {
    const stat = fs.statSync(path.join(runtimeDir, filename));
    assert.equal(stat.uid, hostUid, filename);
    assert.equal(stat.gid, hostGid, filename);
  }
  for (const filename of ['gmail-fixture.cjs', 'package/index.cjs', 'package/package.json']) {
    const stat = fs.statSync(path.join(runtimeDir, filename));
    assert.ok(stat.mode & 0o400, `${filename} must be readable by its owner`);
    assert.equal(stat.uid, hostUid, filename);
    assert.equal(stat.gid, hostGid, filename);
  }
  const fixtureMode = fs.statSync(path.join(runtimeDir, 'gmail-fixture.cjs')).mode & 0o777;
  assert.equal(fixtureMode & 0o022, 0, 'fixture must not be group/world writable');
  assert.equal(resolveRuntimeDirectory(runtimeDir), runtimeDir);
  assert.throws(() => cleanupRuntime(runtimeDir, false), /explicit --confirm/);
  assert.throws(() => resolveRuntimeDirectory(os.tmpdir()), /real directory|generated workflow 09/);

  const parent = JSON.parse(
    fs.readFileSync(path.join(runtimeDir, 'workflows/parent.json'), 'utf8'),
  );
  const child = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'workflows/child.json'), 'utf8'));
  assert.deepEqual(
    JSON.parse(parent.nodes.find((node) => node.name === 'Run One Page').parameters.workflowJson),
    child,
  );
  const configuredCode = parent.nodes.find((node) => node.name === 'Configure Ingestion').parameters
    .jsCode;
  assert.match(configuredCode, /const enableM1 = true/);
  assert.match(configuredCode, /const configurationRevisionId = null/);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'package/index.cjs')), true);
  assert.equal(
    fs.existsSync(path.join(runtimeDir, 'migrations/002_historical_ingestion.sql')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(runtimeDir, 'migrations/003_versioned_evaluation_persistence.sql')),
    true,
  );
});

test('Compose project guard rejects missing, mismatched, occupied, and foreign projects', (t) => {
  const { runtimeDir, projectName } = prepareRuntime();
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const identity = resolveProject(runtimeDir, projectName);
  assert.equal(identity.workingDir, path.dirname(identity.composeFile));
  let dockerCalls = 0;
  const emptyDocker = (command, args) => {
    dockerCalls++;
    assert.equal(command, 'docker');
    assert.ok(args[0] === 'ps' || args[0] === 'network');
    return '';
  };

  assert.throws(() => resolveProject(runtimeDir, undefined), /Invalid workflow 09/);
  assert.throws(() => resolveProject(runtimeDir, 'not-a-project'), /Invalid workflow 09/);
  assert.throws(
    () => resolveProject(runtimeDir, 'mailflow-w09-000000000000'),
    /does not match the generated runtime marker/,
  );
  assertProjectUnused(identity, emptyDocker);
  assert.equal(dockerCalls, 2);
  assert.throws(
    () => assertProjectUnused(identity, () => 'existing-container'),
    /already has Docker resources/,
  );

  const ownedDocker = (command, args) => {
    if (args[0] === 'ps') return 'container-1';
    if (args[0] === 'network' && args[1] === 'ls') return 'network-1';
    if (args[0] === 'inspect' && args[2] === '{{json .Config.Labels}}') {
      return JSON.stringify({
        'com.docker.compose.project': projectName,
        'com.docker.compose.project.config_files': identity.composeFile,
        'com.docker.compose.project.environment_file': identity.environmentFile,
        'com.docker.compose.project.working_dir': identity.workingDir,
        'com.docker.compose.service': 'n8n',
      });
    }
    if (args[0] === 'inspect' && args[2] === '{{json .Labels}}') {
      return JSON.stringify({
        'com.docker.compose.project': projectName,
        'com.docker.compose.network': 'runtime',
      });
    }
    if (args[0] === 'inspect' && args[2] === '{{.Name}}') {
      return `${projectName}_runtime`;
    }
    throw new Error(`Unexpected Docker command: ${command} ${args.join(' ')}`);
  };
  assert.doesNotThrow(() => assertProjectOwned(identity, ownedDocker));

  const foreignDocker = (command, args) => {
    if (args[0] === 'ps' && args[1] === '-aq') return 'container-1';
    if (args[0] === 'network') return '';
    if (args[0] === 'inspect') {
      return JSON.stringify({
        'com.docker.compose.project': projectName,
        'com.docker.compose.project.config_files': '/tmp/unrelated/compose.yaml',
        'com.docker.compose.project.environment_file': identity.environmentFile,
        'com.docker.compose.project.working_dir': '/tmp/unrelated',
        'com.docker.compose.service': 'n8n',
      });
    }
    throw new Error(`Unexpected Docker command: ${command} ${args.join(' ')}`);
  };
  assert.throws(
    () => assertProjectOwned(identity, foreignDocker),
    /not owned by this workflow 09 harness/,
  );

  const wrongWorkingDirectoryDocker = (command, args) => {
    if (args[0] === 'ps' && args[1] === '-aq') return 'container-1';
    if (args[0] === 'network') return '';
    if (args[0] === 'inspect') {
      return JSON.stringify({
        'com.docker.compose.project': projectName,
        'com.docker.compose.project.config_files': identity.composeFile,
        'com.docker.compose.project.environment_file': identity.environmentFile,
        'com.docker.compose.project.working_dir': path.dirname(identity.workingDir),
        'com.docker.compose.service': 'n8n',
      });
    }
    throw new Error(`Unexpected Docker command: ${command} ${args.join(' ')}`);
  };
  assert.throws(
    () => assertProjectOwned(identity, wrongWorkingDirectoryDocker),
    /not owned by this workflow 09 harness/,
  );
});

test('Compose runtime uses isolated internal networks and no named data volumes', () => {
  const compose = fs.readFileSync(path.join(__dirname, 'runtime/workflow-09/compose.yaml'), 'utf8');
  assert.equal((compose.match(/internal: true/g) ?? []).length, 2);
  assert.match(compose, /127\.0\.0\.1::5678/);
  assert.match(compose, /tmpfs:\s*\n\s+- \/var\/lib\/postgresql\/data/);
  assert.match(
    compose,
    /- \/home\/node\/\.n8n:uid=\$\{W09_RUNTIME_UID\},gid=\$\{W09_RUNTIME_GID\},mode=0700/,
  );
  assert.doesNotMatch(compose, /^volumes:\s*$/m);
  assert.match(compose, /pull_policy: never/g);
  assert.equal(
    (compose.match(/user: "\$\{W09_RUNTIME_UID\}:\$\{W09_RUNTIME_GID\}"/g) ?? []).length,
    2,
  );
  assert.match(compose, /N8N_RUNNERS_ENABLED: "true"/);
  assert.match(compose, /N8N_RUNNERS_MODE: internal/);
  const runtimeBindMounts = compose
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ${W09_RUNTIME_DIR'));
  assert.equal(runtimeBindMounts.length, 3);
  assert.ok(
    runtimeBindMounts.every((mount) => mount.endsWith(':ro,z')),
    'every read-only runtime staging bind mount must use shared SELinux relabeling',
  );
  assert.doesNotMatch(compose, /app-bootstrap\.sql:/);
  assert.doesNotMatch(compose, /user: "0:0"/);
  assert.doesNotMatch(compose, /gmail\.googleapis\.com/);
});

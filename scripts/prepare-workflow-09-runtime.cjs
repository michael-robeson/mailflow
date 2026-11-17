'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_PREFIX = 'mailflow-w09-runtime-';

function writeFile(filename, contents, mode = 0o600) {
  fs.writeFileSync(filename, contents, { mode });
  fs.chmodSync(filename, mode);
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Could not uniquely configure ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function configureWorkflows({ ingestionId, accountKey }) {
  if (typeof ingestionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ingestionId)) {
    throw new Error('Invalid synthetic ingestion UUID');
  }
  if (typeof accountKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountKey)) {
    throw new Error('Invalid synthetic account key');
  }
  const parent = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'workflows/09-mailflow-historical-multi-page.json'), 'utf8',
  ));
  const child = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'workflows/09-mailflow-historical-one-page.json'), 'utf8',
  ));

  const listNode = child.nodes.find((node) => node.name === 'List Gmail Page');
  const messageNode = child.nodes.find((node) => node.name === 'Get Full Gmail Message');
  const persistNode = child.nodes.find((node) => node.name === 'Process and Persist Page');
  if (!listNode || !messageNode || !persistNode) {
    throw new Error('Workflow 09 child nodes were not found');
  }
  listNode.parameters.url = "={{ 'http://w09-gmail-mock:8080/gmail/v1/users/me/messages?maxResults=' + Math.min($json.pageSize, $json.maxMessages - $json.discovered) + '&fields=messages%28id%29,nextPageToken' + ($json.query ? '&q=' + encodeURIComponent($json.query) : '') + ($json.nextPageToken ? '&pageToken=' + encodeURIComponent($json.nextPageToken) : '') }}";
  messageNode.parameters.url = "={{ 'http://w09-gmail-mock:8080/gmail/v1/users/me/messages/' + encodeURIComponent($json.id) + '?format=full' }}";

  for (const node of [listNode, messageNode]) {
    delete node.parameters.authentication;
    delete node.parameters.genericAuthType;
    delete node.credentials;
  }

  child.nodes.push({
    parameters: {
      method: 'GET',
      url: "={{ 'http://w09-gmail-mock:8080/checkpoint?pageNumber=' + $json.state.pages }}",
      options: {},
    },
    id: '09b10000-0000-4000-8000-000000000012',
    name: 'Record Page Checkpoint',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1760, 0],
  }, {
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "return [{ json: $('Process and Persist Page').first().json }];",
    },
    id: '09b10000-0000-4000-8000-000000000013',
    name: 'Return Persisted Page',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1980, 0],
  });
  child.connections['Process and Persist Page'] = {
    main: [[{ node: 'Record Page Checkpoint', type: 'main', index: 0 }]],
  };
  child.connections['Record Page Checkpoint'] = {
    main: [[{ node: 'Return Persisted Page', type: 'main', index: 0 }]],
  };

  const configureNode = parent.nodes.find((node) => node.name === 'Configure Ingestion');
  const callNode = parent.nodes.find((node) => node.name === 'Run One Page');
  if (!configureNode || !callNode) throw new Error('Workflow 09 parent configuration nodes were not found');
  let code = configureNode.parameters.jsCode;
  code = replaceExactlyOnce(code, "const ingestionId = '';", `const ingestionId = '${ingestionId}';`, 'ingestion UUID');
  code = replaceExactlyOnce(code, "const accountKey = '';", `const accountKey = '${accountKey}';`, 'account key');
  code = replaceExactlyOnce(code, 'const pageSize = 25;', 'const pageSize = 2;', 'page size');
  code = replaceExactlyOnce(code, 'const maxMessages = 100;', 'const maxMessages = 10;', 'message maximum');
  configureNode.parameters.jsCode = code;

  parent.name = '09 - Mailflow Historical Multi-Page (SYNTHETIC TEST COPY)';
  child.name = '09 - Mailflow Historical One Page (SYNTHETIC TEST COPY)';
  callNode.parameters.workflowJson = JSON.stringify(child);
  return { parent, child };
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function createVerificationSql({ ingestionId, accountKey }) {
  const ingestion = sqlLiteral(ingestionId);
  const account = sqlLiteral(accountKey);
  return `DO $verify$
DECLARE
  checkpoint_count integer;
  first_page integer;
  last_page integer;
  final_state jsonb;
  run_count integer;
  message_count integer;
  classification_count integer;
  decision_count integer;
BEGIN
  SELECT count(*)::int, min(page_number), max(page_number)
    INTO checkpoint_count, first_page, last_page
    FROM mailflow.historical_checkpoints
    WHERE ingestion_id = ${ingestion};
  SELECT state INTO final_state
    FROM mailflow.historical_checkpoints
    WHERE ingestion_id = ${ingestion}
    ORDER BY page_number DESC LIMIT 1;
  SELECT count(*)::int INTO run_count
    FROM mailflow.workflow_runs WHERE account_key = ${account};
  SELECT count(*)::int INTO message_count
    FROM mailflow.messages WHERE account_key = ${account};
  SELECT count(*)::int INTO classification_count
    FROM mailflow.classifications WHERE account_key = ${account};
  SELECT count(*)::int INTO decision_count
    FROM mailflow.policy_decisions p
    JOIN mailflow.classifications c ON c.id = p.classification_id
    WHERE c.account_key = ${account};

  IF checkpoint_count <> 3 OR first_page <> 1 OR last_page <> 3
    OR final_state->>'pages' <> '3'
    OR final_state->>'discovered' <> '5'
    OR final_state->>'persisted' <> '5'
    OR final_state->>'failed' <> '0'
    OR final_state->'hasMore' <> 'false'::jsonb
    OR final_state->'nextPageToken' <> 'null'::jsonb
    OR run_count <> 5 OR message_count <> 5
    OR classification_count <> 5 OR decision_count <> 5 THEN
    RAISE EXCEPTION 'Workflow 09 synthetic success acceptance failed';
  END IF;
  RAISE NOTICE 'Workflow 09 synthetic success acceptance passed';
END
$verify$;

SELECT page_number,
       (state->>'discovered')::int AS discovered,
       (state->>'persisted')::int AS persisted,
       (state->>'failed')::int AS failed,
       state->>'hasMore' AS has_more
FROM mailflow.historical_checkpoints
WHERE ingestion_id = ${ingestion}
ORDER BY page_number;
`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function makeRuntimeDirectory() {
  const suffix = crypto.randomBytes(6).toString('hex');
  const runtimeDir = path.join(os.tmpdir(), `${RUNTIME_PREFIX}${suffix}`);
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  return { runtimeDir, suffix };
}

function prepareRuntime() {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new Error('Runtime preparation requires a POSIX host with process UID/GID support');
  }
  const { runtimeDir, suffix } = makeRuntimeDirectory();
  const projectName = `mailflow-w09-${suffix}`;
  const appPassword = crypto.randomBytes(32).toString('hex');
  const ownerPassword = crypto.randomBytes(32).toString('hex');
  const ingestionId = crypto.randomUUID();
  const accountKey = `w09_synthetic_${suffix}`;

  try {
    for (const directory of ['app-secret', 'migrations', 'package', 'workflows']) {
      fs.mkdirSync(path.join(runtimeDir, directory), { mode: 0o700 });
    }

    writeFile(path.join(runtimeDir, 'app-secret/app-password'), appPassword);

    writeFile(path.join(runtimeDir, 'app-bootstrap.sql'), [
      `CREATE ROLE mailflow_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${ownerPassword}';`,
      `CREATE ROLE mailflow_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${appPassword}';`,
      'ALTER DATABASE mailflow OWNER TO mailflow_owner;',
      'REVOKE ALL ON DATABASE mailflow FROM PUBLIC;',
      'GRANT CONNECT ON DATABASE mailflow TO mailflow_app;',
      '',
    ].join('\n'));

    const runtimeEnv = {
      W09_RUNTIME_DIR: runtimeDir,
      W09_RUNTIME_UID: String(process.getuid()),
      W09_RUNTIME_GID: String(process.getgid()),
      W09_N8N_DB_PASSWORD: crypto.randomBytes(32).toString('hex'),
      W09_APP_DB_ADMIN_PASSWORD: crypto.randomBytes(32).toString('hex'),
      W09_N8N_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    };
    writeFile(path.join(runtimeDir, 'compose.env'), `${Object.entries(runtimeEnv)
      .map(([key, value]) => `${key}=${value}`).join('\n')}\n`);

    for (const filename of fs.readdirSync(path.join(ROOT, 'lib')).filter((name) => name.endsWith('.cjs'))) {
      fs.copyFileSync(path.join(ROOT, 'lib', filename), path.join(runtimeDir, 'package', filename));
    }
    writeFile(path.join(runtimeDir, 'package/package.json'), JSON.stringify({
      name: 'mailflow-pipeline',
      version: '1.0.0',
      private: true,
      main: 'index.cjs',
    }, null, 2) + '\n', 0o644);

    for (const filename of ['001_persistence_foundation.sql', '002_historical_ingestion.sql']) {
      fs.copyFileSync(
        path.join(ROOT, 'migrations', filename),
        path.join(runtimeDir, 'migrations', filename),
      );
    }
    fs.copyFileSync(
      path.join(ROOT, 'tests/runtime/workflow-09/gmail-fixture.cjs'),
      path.join(runtimeDir, 'gmail-fixture.cjs'),
    );

    const { parent, child } = configureWorkflows({ ingestionId, accountKey });
    writeFile(path.join(runtimeDir, 'workflows/parent.json'), `${JSON.stringify(parent, null, 2)}\n`, 0o600);
    writeFile(path.join(runtimeDir, 'workflows/child.json'), `${JSON.stringify(child, null, 2)}\n`, 0o600);
    writeFile(path.join(runtimeDir, 'verify-success.sql'), createVerificationSql({ ingestionId, accountKey }));
    writeFile(path.join(runtimeDir, 'scenario.json'), `${JSON.stringify({
      ingestionId, accountKey, pageSize: 2, maxMessages: 10,
    }, null, 2)}\n`);
    writeFile(path.join(runtimeDir, '.mailflow-w09-runtime'), JSON.stringify({
      version: 1, projectName,
    }) + '\n');
    writeFile(path.join(runtimeDir, 'runtime-paths.sh'), [
      `export W09_RUNTIME_DIR=${shellQuote(runtimeDir)}`,
      `export W09_PROJECT=${shellQuote(projectName)}`,
      '',
    ].join('\n'));

    return { runtimeDir, projectName };
  } catch (error) {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

function resolveRuntimeDirectory(runtimeDir) {
  const requested = path.resolve(runtimeDir);
  const entry = fs.lstatSync(requested);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('Runtime path must be a real directory');
  }
  const resolved = fs.realpathSync(requested);
  const tempRoot = fs.realpathSync(os.tmpdir());
  const basename = path.basename(resolved);
  const suffix = basename.startsWith(RUNTIME_PREFIX) ? basename.slice(RUNTIME_PREFIX.length) : '';
  if (path.dirname(resolved) !== tempRoot || !/^[a-f0-9]{12}$/.test(suffix)) {
    throw new Error('Refusing to remove a path outside the generated workflow 09 temp directory');
  }

  const marker = JSON.parse(fs.readFileSync(path.join(resolved, '.mailflow-w09-runtime'), 'utf8'));
  if (marker.version !== 1 || marker.projectName !== `mailflow-w09-${suffix}`) {
    throw new Error('Runtime marker does not match the generated workflow 09 directory');
  }
  return resolved;
}

function cleanupRuntime(runtimeDir, confirmed) {
  if (confirmed !== true) throw new Error('Cleanup requires the explicit --confirm option');
  const resolved = resolveRuntimeDirectory(runtimeDir);
  fs.rmSync(resolved, { recursive: true, force: false });
  return resolved;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/prepare-workflow-09-runtime.cjs');
    const { runtimeDir, projectName } = prepareRuntime();
    console.log(`Prepared isolated runtime assets: ${runtimeDir}`);
    console.log(`Compose project: ${projectName}`);
    console.log(`After review, load non-secret paths with: . ${path.join(runtimeDir, 'runtime-paths.sh')}`);
    console.log('No containers or databases were started or accessed.');
  } catch (error) {
    console.error(`Workflow 09 runtime preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  cleanupRuntime,
  configureWorkflows,
  createVerificationSql,
  prepareRuntime,
  resolveRuntimeDirectory,
};

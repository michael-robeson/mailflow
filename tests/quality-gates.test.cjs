'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const { parseJsonWithoutDuplicateKeys, workflowErrors, secretErrors } = require('../scripts/validate.cjs');

const workflow = (nodes = []) => ({ active: false, pinData: {}, nodes });
const node = (type, parameters = {}) => ({ name: 'synthetic', type, parameters });

test('JSON validation rejects duplicate decoded keys at every depth', () => {
  assert.deepEqual(parseJsonWithoutDuplicateKeys('{"a":[{"x":1},{"x":2}]}'), { a: [{ x: 1 }, { x: 2 }] });
  assert.throws(() => parseJsonWithoutDuplicateKeys('{"a":1,"\\u0061":2}'), /Duplicate JSON key/);
  assert.throws(() => parseJsonWithoutDuplicateKeys('{"a":[{"x":1,"x":2}]}'), /Duplicate JSON key/);
  assert.throws(() => parseJsonWithoutDuplicateKeys('{"a":}'), SyntaxError);
});

test('workflow validation requires inactive workflows without pinned data or credential bindings', () => {
  assert.deepEqual(workflowErrors(workflow()), []);
  assert.match(workflowErrors({ active: true, nodes: [] }).join(), /inactive/);
  assert.match(workflowErrors({ nodes: [] }).join(), /inactive/);
  assert.match(workflowErrors({ active: false, nodes: [], pinData: { result: [{}] } }).join(), /pinned/);
  const withCredentials = workflow([node('n8n-nodes-base.httpRequest')]);
  withCredentials.nodes[0].credentials = { oAuth2Api: { id: 'local-id' } };
  assert.match(workflowErrors(withCredentials).join(), /credential/);
  assert.match(workflowErrors(workflow([node('n8n-nodes-base.httpRequest', {
    headerParameters: { parameters: [{ name: 'Authorization', value: 'synthetic' }] },
  })])).join(), /header/);
  assert.match(workflowErrors(workflow([node('n8n-nodes-base.httpRequest', {
    headers: { authorization: 'synthetic', [['api', 'key'].join('_')]: 'synthetic' },
  })])).join(), /credential/);
});

test('workflow validation rejects destructive, dynamic or missing Gmail operations and non-GET HTTP', () => {
  const gmail = (resource, operation) => node('n8n-nodes-base.gmail', { resource, operation });
  assert.deepEqual(workflowErrors(workflow([gmail('message', 'getAll')])), []);
  for (const operation of ['delete', 'trash', 'modify', 'send', '={{ $json.operation }}', undefined]) {
    assert.match(workflowErrors(workflow([gmail('message', operation)])).join(), /read-only/);
  }
  assert.match(workflowErrors(workflow([gmail('draft', 'get')])).join(), /read-only/);
  assert.deepEqual(workflowErrors(workflow([node('n8n-nodes-base.httpRequest')])), []);
  assert.deepEqual(workflowErrors(workflow([node('n8n-nodes-base.httpRequest', { method: 'GET' })])), []);
  for (const method of ['POST', 'DELETE', '={{ $json.method }}']) {
    assert.match(workflowErrors(workflow([node('n8n-nodes-base.httpRequest', { method })])).join(), /GET/);
  }
  for (const jsCode of ['fetch(url)', '$http.request(options)', 'this.helpers.httpRequest(options)', "require('https')"]) {
    assert.match(workflowErrors(workflow([node('n8n-nodes-base.code', { jsCode })])).join(), /network or module/);
  }
});

test('secret scanner flags sensitive paths and representative secrets without reporting values', () => {
  assert.deepEqual(secretErrors('.env.example', 'POSTGRES_PASSWORD=\n'), []);
  for (const filename of ['.env', '.env.local', 'credentials/export.json', 'key.pem', '.n8n/state']) {
    assert.ok(secretErrors(filename, '').length, filename);
  }
  const samples = [
    ['private key', ['-----BEGIN ', 'PRIVATE KEY-----'].join('')],
    ['GitHub token', ['ghp', '_', 'A'.repeat(36)].join('')],
    ['Google API key', ['AIza', 'A'.repeat(35)].join('')],
    ['Google OAuth token', ['ya29', '.', 'a'.repeat(25)].join('')],
    ['AWS access key', ['AKIA', 'A'.repeat(16)].join('')],
    ['credential assignment', ['client', '_secret=', 'abcdefgh1234'].join('')],
    ['bearer token', ['Bearer ', 'a'.repeat(25)].join('')],
  ];
  for (const [label, value] of samples) {
    const errors = secretErrors('example.txt', value);
    assert.ok(errors.some((error) => error.includes(label)), label);
    assert.ok(errors.every((error) => !error.includes(value)), 'must not print secret values');
  }
  assert.deepEqual(secretErrors('example.txt', 'client_secret=\naccess_token=${TOKEN}\n'), []);
});

test('staged validation checks the index rather than unstaged file contents', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailflow-gates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { cwd: root, encoding: 'utf8' };
  const git = (...args) => execFileSync('git', args, options);
  const validate = () => spawnSync(process.execPath, [
    path.join(__dirname, '../scripts/validate.cjs'), '--staged',
  ], options);
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'workflows'));
  const filename = path.join(root, 'workflows/test.json');
  fs.writeFileSync(filename, '{"active":false,"nodes":[]}');
  git('add', 'workflows/test.json');
  fs.writeFileSync(filename, '{"active":true,"nodes":[]}');
  assert.equal(validate().status, 0, 'unstaged unsafe content must not change the staged result');
  git('add', 'workflows/test.json');
  fs.writeFileSync(filename, '{"active":false,"nodes":[]}');
  const result = validate();
  assert.equal(result.status, 1, 'unsafe staged content must be rejected');
  assert.match(result.stderr, /inactive/);
  git('add', 'workflows/test.json');
  fs.writeFileSync(path.join(root, '.env'), 'SYNTHETIC=example\n');
  git('add', '-f', '.env');
  const envResult = validate();
  assert.equal(envResult.status, 1, 'force-staged environment files must be rejected');
  assert.match(envResult.stderr, /environment file/);
});

test('hook installation is repeatable, respects existing hooks, and runs staged validation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailflow-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { cwd: root, encoding: 'utf8' };
  const git = (...args) => execFileSync('git', args, options);
  const run = (file) => spawnSync('sh', [file], options);
  git('init', '-q');
  for (const directory of ['.githooks', 'scripts', 'tests', 'workflows']) {
    fs.mkdirSync(path.join(root, directory));
  }
  for (const file of ['.githooks/pre-commit', 'scripts/install-hooks.sh', 'scripts/validate.cjs']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
  }
  fs.writeFileSync(path.join(root, 'tests/example.test.cjs'), "require('node:test')('synthetic', () => {});\n");
  fs.writeFileSync(path.join(root, 'workflows/example.json'), '{"active":false,"nodes":[]}');
  git('add', '.');
  assert.equal(run('scripts/install-hooks.sh').status, 0);
  assert.equal(run('scripts/install-hooks.sh').status, 0);
  assert.equal(git('config', '--local', '--get', 'core.hooksPath').trim(), '.githooks');
  assert.equal(run('.githooks/pre-commit').status, 0);
  fs.writeFileSync(path.join(root, 'workflows/example.json'), '{"active":true,"nodes":[]}');
  git('add', 'workflows/example.json');
  const rejected = run('.githooks/pre-commit');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /inactive/);
  git('config', '--local', 'core.hooksPath', 'other-hooks');
  assert.equal(run('scripts/install-hooks.sh').status, 1);
  assert.equal(git('config', '--local', '--get', 'core.hooksPath').trim(), 'other-hooks');
});

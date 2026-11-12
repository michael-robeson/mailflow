#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// JSON.parse validates syntax first; this second pass checks decoded object keys.
function parseJsonWithoutDuplicateKeys(text) {
  const parsed = JSON.parse(text);
  let index = 0;
  const whitespace = () => {
    while (/\s/.test(text[index] ?? '') && index < text.length) index++;
  };
  function string() {
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
      } else if (text[index++] === '"') {
        return JSON.parse(text.slice(start, index));
      }
    }
    throw new SyntaxError('Unterminated JSON string');
  }
  function value() {
    whitespace();
    if (text[index] === '{') {
      index++;
      const keys = new Set();
      whitespace();
      if (text[index] === '}') {
        index++;
        return;
      }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new SyntaxError('Duplicate JSON key');
        keys.add(key);
        whitespace();
        index++; // colon
        value();
        whitespace();
        if (text[index++] === '}') return;
      }
    }
    if (text[index] === '[') {
      index++;
      whitespace();
      if (text[index] === ']') {
        index++;
        return;
      }
      while (true) {
        value();
        whitespace();
        if (text[index++] === ']') return;
      }
    }
    if (text[index] === '"') {
      string();
      return;
    }
    while (index < text.length && !/[\s,\]}]/.test(text[index])) index++;
  }
  value();
  return parsed;
}

function workflowErrors(workflow) {
  const errors = [];
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    return ['workflow must be an object'];
  }
  if (workflow.active !== false) errors.push('workflow must be explicitly inactive');
  if (!Array.isArray(workflow.nodes)) return [...errors, 'workflow must have a nodes array'];
  if (workflow.pinData && Object.keys(workflow.pinData).length) errors.push('pinned data is not allowed');

  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.replace(/[-_]/g, '').toLowerCase();
      if (['credentials', 'clientsecret', 'accesstoken', 'refreshtoken', 'apikey',
        'password', 'passwd', 'privatekey', 'secret', 'authorization', 'proxyauthorization', 'xapikey'].includes(normalizedKey)) {
        errors.push(`embedded credential field is not allowed: ${key}`);
      }
      if (key.toLowerCase() === 'name' && typeof nested === 'string' &&
          /^(authorization|proxy-authorization|x-api-key)$/i.test(nested)) {
        errors.push('credential-bearing header is not allowed');
      }
      inspect(nested);
    }
  }
  inspect(workflow);

  for (const node of workflow.nodes) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
      errors.push('each node must have a type');
      continue;
    }
    const parameters = node.parameters ?? {};
    if (node.type === 'n8n-nodes-base.httpRequest') {
      if (parameters.method !== undefined && parameters.method !== 'GET') {
        errors.push(`${node.name ?? 'HTTP node'}: only literal GET requests are allowed`);
      }
    }
    if (node.type === 'n8n-nodes-base.code' && typeof parameters.jsCode === 'string' &&
        /\bfetch\s*\(|\$http\b|(?:helpers\.)?httpRequest\s*\(|\brequire\s*\(|\bimport\s*(?:\(|[\w*{])/i.test(parameters.jsCode)) {
      errors.push(`${node.name ?? 'Code node'}: direct network or module access requires manual review`);
    }
    if (node.type === 'n8n-nodes-base.gmail') {
      const resource = parameters.resource;
      const operation = parameters.operation;
      if (!['message', 'thread', 'label'].includes(resource) || !['get', 'getAll'].includes(operation)) {
        errors.push(`${node.name ?? 'Gmail node'}: only read-only Gmail operations are allowed`);
      }
    }
  }
  return errors;
}

const secretPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Google OAuth token', /\bya29\.[0-9A-Za-z_-]{20,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['credential assignment', /(?:^|[\s"'`,{])(?:password|passwd|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|n8n_encryption_key|postgres_password)[ \t]*["']?[ \t]*[:=][ \t]*(?:["'][^"'$\s]{8,}["']|[A-Za-z0-9_+/.-]{8,})/im],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i],
];

function secretErrors(filename, content) {
  const errors = [];
  const basename = path.posix.basename(filename).toLowerCase();
  if ((basename === '.env' || basename.startsWith('.env.')) && basename !== '.env.example') {
    errors.push('environment file must not be committed');
  }
  if (/(^|\/)(?:credentials|secrets|\.n8n|postgres_data|pgdata)(?:\/|$)/i.test(filename) ||
      /(?:^|\/)(?:client_secret|credentials|token)[^/]*\.json$/i.test(filename) ||
      /\.(?:pem|key|p12|pfx|sqlite3?|db|dump)$/i.test(filename)) {
    errors.push('sensitive or local-state file must not be committed');
  }
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(content)) errors.push(`possible ${label} detected`);
  }
  return errors;
}

function git(args, options = {}) {
  return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024, ...options });
}

function validateRepository(staged = false) {
  const root = git(['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const args = staged
    ? ['ls-files', '--cached', '-z']
    : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  const files = [...new Set(git(args, { cwd: root }).toString('utf8').split('\0').filter(Boolean))];
  const errors = [];
  let workflows = 0;
  for (const filename of files) {
    let content;
    try {
      content = staged
        ? git(['show', `:${filename}`], { cwd: root })
        : fs.readFileSync(path.join(root, filename));
    } catch (error) {
      errors.push(`${filename}: could not read file: ${error.message}`);
      continue;
    }
    const text = content.toString('utf8');
    for (const issue of secretErrors(filename, text)) errors.push(`${filename}: ${issue}`);
    if (filename.startsWith('workflows/') && filename.toLowerCase().endsWith('.json')) {
      workflows++;
      let workflow;
      try {
        workflow = parseJsonWithoutDuplicateKeys(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const detail = error.message === 'Duplicate JSON key' ? error.message : 'invalid JSON syntax';
        errors.push(`${filename}: invalid workflow JSON: ${detail}`);
        continue;
      }
      for (const issue of workflowErrors(workflow)) errors.push(`${filename}: ${issue}`);
    }
  }
  if (!workflows) errors.push('No workflow JSON exports found under workflows/');
  return { errors, workflows, files: files.length };
}

if (require.main === module) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--staged')) {
    console.error('Usage: node scripts/validate.cjs [--staged]');
    process.exitCode = 2;
  } else {
    try {
      const result = validateRepository(process.argv[2] === '--staged');
      if (result.errors.length) {
        for (const error of result.errors) console.error(`ERROR: ${error}`);
        process.exitCode = 1;
      } else {
        console.log(`Validated ${result.workflows} workflow exports and scanned ${result.files} files.`);
      }
    } catch (error) {
      console.error(`Validation failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { parseJsonWithoutDuplicateKeys, workflowErrors, secretErrors, validateRepository };

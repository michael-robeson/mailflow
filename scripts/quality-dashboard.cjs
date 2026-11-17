'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const integrationSuites = [
  ['persistence-postgres', 'PostgreSQL persistence'],
  ['live-persistence-postgres', 'Live persistence'],
  ['historical-ingestion-postgres', 'Historical ingestion'],
  ['versioned-persistence-postgres', 'Versioned persistence'],
];

function percentage(covered, found) {
  return found === 0 ? null : (covered / found) * 100;
}

function parseLcov(text) {
  const files = [];
  let current;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      if (current) files.push(current);
      current = {
        file: path
          .relative(root, path.resolve(root, line.slice(3)))
          .split(path.sep)
          .join('/'),
        linesFound: 0,
        linesHit: 0,
        branchesFound: 0,
        branchesHit: 0,
        functionsFound: 0,
        functionsHit: 0,
      };
    } else if (current && /^(LF|LH|BRF|BRH|FNF|FNH):/.test(line)) {
      const [key, value] = line.split(':');
      const metric = {
        LF: 'linesFound',
        LH: 'linesHit',
        BRF: 'branchesFound',
        BRH: 'branchesHit',
        FNF: 'functionsFound',
        FNH: 'functionsHit',
      }[key];
      current[metric] = Number(value);
    } else if (line === 'end_of_record' && current) {
      files.push(current);
      current = undefined;
    }
  }
  if (current) files.push(current);
  return files.map((file) => ({
    module: file.file,
    lines: {
      covered: file.linesHit,
      found: file.linesFound,
      percent: percentage(file.linesHit, file.linesFound),
    },
    branches: {
      covered: file.branchesHit,
      found: file.branchesFound,
      percent: percentage(file.branchesHit, file.branchesFound),
    },
    functions: {
      covered: file.functionsHit,
      found: file.functionsFound,
      percent: percentage(file.functionsHit, file.functionsFound),
    },
  }));
}

function totalCoverage(modules) {
  const totals = {
    lines: { covered: 0, found: 0 },
    branches: { covered: 0, found: 0 },
    functions: { covered: 0, found: 0 },
  };
  for (const module of modules) {
    for (const metric of Object.keys(totals)) {
      totals[metric].covered += module[metric].covered;
      totals[metric].found += module[metric].found;
    }
  }
  for (const metric of Object.keys(totals)) {
    totals[metric].percent = percentage(totals[metric].covered, totals[metric].found);
  }
  return totals;
}

function parseTap(text) {
  const read = (label) => {
    const matches = [...text.matchAll(new RegExp(`^# ${label} (\\d+(?:\\.\\d+)?)$`, 'gm'))];
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
  };
  const tests = read('tests');
  if (tests === null) return null;
  const failed = (read('fail') ?? 0) + (read('cancelled') ?? 0);
  return {
    passed: read('pass') ?? 0,
    failed,
    skipped: (read('skipped') ?? 0) + (read('todo') ?? 0),
    elapsedMs: read('duration_ms'),
  };
}

function summarizeComplexity(functions, moduleNames = []) {
  const byModule = new Map();
  for (const module of moduleNames) byModule.set(module, []);
  for (const fn of functions) {
    if (!byModule.has(fn.module)) byModule.set(fn.module, []);
    byModule.get(fn.module).push(fn);
  }
  const summarize = (items) => ({
    average: items.length
      ? Number((items.reduce((sum, fn) => sum + fn.complexity, 0) / items.length).toFixed(2))
      : null,
    maximum: items.length ? Math.max(...items.map((fn) => fn.complexity)) : null,
    functionCount: items.length,
    existingThresholdViolations: items.filter((fn) => fn.thresholdViolation).length,
  });
  return {
    overall: summarize(functions),
    modules: Object.fromEntries([...byModule].map(([module, items]) => [module, summarize(items)])),
    functions,
  };
}

async function collectComplexity() {
  const { ESLint } = require('eslint');
  const baseline = await new ESLint().lintFiles(['lib/**/*.cjs']);
  const allFunctionsLinter = new ESLint({
    allowInlineConfig: false,
    overrideConfig: [
      {
        files: ['lib/**/*.cjs'],
        rules: { complexity: ['warn', 0] },
      },
    ],
  });
  const allFunctions = await allFunctionsLinter.lintFiles(['lib/**/*.cjs']);
  const violations = new Set();
  for (const result of baseline) {
    for (const message of result.messages) {
      if (message.ruleId === 'complexity' && !/^Program\b/.test(message.message)) {
        violations.add(`${path.relative(root, result.filePath)}:${message.line}:${message.column}`);
      }
    }
  }

  const functions = [];
  for (const result of allFunctions) {
    for (const message of result.messages) {
      if (message.ruleId !== 'complexity' || /^Program\b/.test(message.message)) continue;
      const match = message.message.match(/complexity of (\d+)/i);
      if (!match) continue;
      const module = path.relative(root, result.filePath).split(path.sep).join('/');
      functions.push({
        module,
        line: message.line,
        column: message.column,
        complexity: Number(match[1]),
        thresholdViolation: violations.has(
          `${path.relative(root, result.filePath)}:${message.line}:${message.column}`,
        ),
      });
    }
  }
  return summarizeComplexity(
    functions,
    allFunctions.map((result) => path.relative(root, result.filePath).split(path.sep).join('/')),
  );
}

function readStatus(value) {
  return ['success', 'failure', 'cancelled', 'skipped'].includes(value) ? value : 'not_run';
}

function runIdentity() {
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  return {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: Number.isInteger(attempt) && attempt > 0 ? attempt : null,
    commitSha: process.env.GITHUB_SHA ?? null,
    ref: process.env.GITHUB_REF ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
  };
}

function readSuite(name, category, file, commandOutcome, reportsRoot = root) {
  const filename = path.join(reportsRoot, file);
  if (!fs.existsSync(filename)) {
    return {
      name,
      category,
      status: commandOutcome === 'success' ? 'unavailable' : 'not_run',
      passed: null,
      failed: null,
      skipped: null,
      elapsedMs: null,
    };
  }
  const result = parseTap(fs.readFileSync(filename, 'utf8'));
  if (!result) {
    return {
      name,
      category,
      status: 'unavailable',
      passed: null,
      failed: null,
      skipped: null,
      elapsedMs: null,
    };
  }
  return {
    name,
    category,
    status: result.failed > 0 ? 'failure' : 'success',
    ...result,
  };
}

function readIntegrationSuites(reportsRoot, commandOutcome) {
  return integrationSuites.map(([filename, label]) =>
    readSuite(label, 'Integration', `${filename}.tap`, commandOutcome, reportsRoot),
  );
}

function makeSuite(name, category, status, result) {
  return {
    name,
    category,
    status,
    passed: result?.passed ?? null,
    failed: result?.failed ?? null,
    skipped: result?.skipped ?? null,
    elapsedMs: result?.elapsedMs ?? null,
  };
}

async function collectValidate() {
  fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });
  const diagnostics = [];
  let coverage = null;
  let complexity = null;
  try {
    const lcovPath = path.join(root, 'coverage/lcov.info');
    if (!fs.existsSync(lcovPath)) throw new Error('coverage/lcov.info was not produced');
    const modules = parseLcov(fs.readFileSync(lcovPath, 'utf8'));
    if (!modules.length) throw new Error('coverage/lcov.info contained no module records');
    coverage = { overall: totalCoverage(modules), modules };
  } catch (error) {
    diagnostics.push(`Coverage metrics unavailable: ${error.message}`);
  }
  try {
    complexity = await collectComplexity();
  } catch (error) {
    diagnostics.push(`Complexity metrics unavailable: ${error.message}`);
  }
  const syntheticOutcome = readStatus(process.env.SYNTHETIC_OUTCOME);
  const suites = [
    readSuite(
      'Synthetic / Component',
      'Synthetic / Component',
      'coverage/synthetic.tap',
      syntheticOutcome,
    ),
    makeSuite('E2E', 'E2E', 'not_configured', null),
  ];
  const metrics = {
    schemaVersion: 1,
    run: runIdentity(),
    qualityGates: {
      dependencyInstallation: readStatus(process.env.INSTALL_OUTCOME),
      formatting: readStatus(process.env.FORMAT_OUTCOME),
      lint: readStatus(process.env.LINT_OUTCOME),
      repositoryValidation: readStatus(process.env.VALIDATION_OUTCOME),
      syntheticTests: syntheticOutcome,
    },
    suites,
    coverage,
    complexity,
    diagnostics,
  };
  fs.writeFileSync(
    path.join(root, 'coverage/quality-metrics-validate.json'),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
}

function collectPostgres() {
  fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });
  const integrationOutcome = readStatus(process.env.INTEGRATION_OUTCOME);
  const suites = readIntegrationSuites(path.join(root, 'coverage/postgres'), integrationOutcome);
  const metrics = {
    schemaVersion: 1,
    run: runIdentity(),
    qualityGates: {
      postgresImagePull: readStatus(process.env.POSTGRES_IMAGES_OUTCOME),
      postgresIntegration: integrationOutcome,
    },
    suites,
    diagnostics: [],
  };
  fs.writeFileSync(
    path.join(root, 'coverage/quality-metrics-postgres.json'),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
}

function markdownPercent(metric) {
  if (!metric || metric.percent === null) return 'N/A';
  return `${metric.percent.toFixed(1)}% (${metric.covered}/${metric.found})`;
}

function displayStatus(status) {
  return (
    {
      success: 'Passed',
      failure: 'Failed',
      cancelled: 'Cancelled',
      skipped: 'Skipped',
      not_run: 'Not Run',
      unavailable: 'Unavailable',
      not_configured: 'Not Configured',
    }[status] ?? status
  );
}

function elapsed(value) {
  return value === null || value === undefined ? 'N/A' : `${(value / 1000).toFixed(2)} s`;
}

function renderSuites(suites) {
  const lines = [
    '## Test suites',
    '',
    '| Category | Suite | Status | Passed | Failed | Skipped | Elapsed |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
  ];
  for (const suite of suites) {
    const value = (count) => (count === null || count === undefined ? 'N/A' : count);
    lines.push(
      `| ${suite.category} | ${suite.name} | ${displayStatus(suite.status)} | ${value(suite.passed)} | ${value(suite.failed)} | ${value(suite.skipped)} | ${elapsed(suite.elapsedMs)} |`,
    );
  }
  return lines;
}

function renderCoverage(coverage) {
  if (!coverage) return ['## Coverage', '', 'Coverage diagnostics are unavailable.'];
  const lines = [
    '## Coverage',
    '',
    '| Module | Lines | Branches | Functions |',
    '| --- | ---: | ---: | ---: |',
    `| **Overall** | ${markdownPercent(coverage.overall.lines)} | ${markdownPercent(coverage.overall.branches)} | ${markdownPercent(coverage.overall.functions)} |`,
  ];
  for (const module of coverage.modules) {
    lines.push(
      `| ${module.module} | ${markdownPercent(module.lines)} | ${markdownPercent(module.branches)} | ${markdownPercent(module.functions)} |`,
    );
  }
  return lines;
}

function renderComplexity(complexity) {
  if (!complexity) {
    return ['## Cyclomatic complexity', '', 'Complexity diagnostics are unavailable.'];
  }
  const lines = [
    '## Cyclomatic complexity',
    '',
    '| Module | Average | Maximum | Functions | Existing-threshold violations |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| **Overall** | ${complexity.overall.average ?? 'N/A'} | ${complexity.overall.maximum ?? 'N/A'} | ${complexity.overall.functionCount} | ${complexity.overall.existingThresholdViolations} |`,
  ];
  for (const [module, value] of Object.entries(complexity.modules)) {
    lines.push(
      `| ${module} | ${value.average ?? 'N/A'} | ${value.maximum ?? 'N/A'} | ${value.functionCount} | ${value.existingThresholdViolations} |`,
    );
  }
  return lines;
}

function renderQualityGates(gates, diagnostics) {
  const lines = ['', '## Quality gates', '', '| Gate | Outcome |', '| --- | --- |'];
  for (const [gate, outcome] of Object.entries(gates)) {
    lines.push(`| ${gate} | ${displayStatus(outcome)} |`);
  }
  if (diagnostics.length) {
    lines.push('', '## Diagnostics', '');
    for (const diagnostic of diagnostics) lines.push(`- ${diagnostic}`);
  }
  return lines;
}

function renderSummary(metrics) {
  const { run } = metrics;
  const runUrl =
    run.repository && run.runId
      ? `https://github.com/${run.repository}/actions/runs/${run.runId}/attempts/${run.runAttempt ?? 1}`
      : null;
  return [
    '# Engineering quality dashboard',
    '',
    `Run: ${runUrl ? `[${run.runId} #${run.runAttempt ?? 1}](${runUrl})` : 'local or unavailable'}`,
    `Commit: ${run.commitSha ?? 'N/A'} · Ref: ${run.ref ?? 'N/A'} · Workflow: ${run.workflow ?? 'N/A'}`,
    '',
    ...renderSuites(metrics.suites),
    '',
    ...renderCoverage(metrics.coverage),
    '',
    ...renderComplexity(metrics.complexity),
    ...renderQualityGates(metrics.qualityGates, metrics.diagnostics),
    '',
    '',
    'Metrics are informational; no coverage or complexity thresholds were added.',
    'The versioned JSON metrics are attached as the `engineering-quality-metrics-v1` artifact.',
    '',
  ].join('\n');
}

function readPartial(filename) {
  const fullPath = path.join(root, 'coverage/partials', filename);
  return fs.existsSync(fullPath) ? JSON.parse(fs.readFileSync(fullPath, 'utf8')) : null;
}

function combineMetrics(validate, postgres) {
  const diagnostics = [...(validate?.diagnostics ?? []), ...(postgres?.diagnostics ?? [])];
  if (!validate) diagnostics.push('Offline quality metrics artifact was not available.');
  if (!postgres) diagnostics.push('PostgreSQL quality metrics artifact was not available.');
  return {
    schemaVersion: 1,
    run: runIdentity(),
    qualityGates: {
      ...(validate?.qualityGates ?? {}),
      ...(postgres?.qualityGates ?? {}),
    },
    suites: [
      ...(validate?.suites ?? [
        makeSuite('Synthetic / Component', 'Synthetic / Component', 'not_run', null),
        makeSuite('E2E', 'E2E', 'not_configured', null),
      ]),
      ...(postgres?.suites ??
        integrationSuites.map(([, label]) => makeSuite(label, 'Integration', 'not_run', null))),
    ],
    coverage: validate?.coverage ?? null,
    complexity: validate?.complexity ?? null,
    diagnostics,
  };
}

function aggregate() {
  const validate = readPartial('quality-metrics-validate.json');
  const postgres = readPartial('quality-metrics-postgres.json');
  const metrics = combineMetrics(validate, postgres);
  fs.writeFileSync(
    path.join(root, 'quality-metrics.json'),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
  const summary = renderSummary(metrics);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  } else {
    process.stdout.write(summary);
  }
}

function enforce(filename) {
  const fullPath = path.join(root, filename);
  if (!fs.existsSync(fullPath)) {
    console.error(`Quality metrics report is missing: ${filename}`);
    process.exitCode = 1;
    return;
  }
  const metrics = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const failures = Object.entries(metrics.qualityGates).filter(
    ([, outcome]) => outcome !== 'success',
  );
  if (failures.length) {
    console.error(`Quality gates failed: ${failures.map(([gate]) => gate).join(', ')}`);
    process.exitCode = 1;
  }
}

async function main() {
  switch (process.argv[2]) {
    case 'collect-validate':
      await collectValidate();
      break;
    case 'collect-postgres':
      collectPostgres();
      break;
    case 'aggregate':
      aggregate();
      break;
    case 'enforce-validate':
      enforce('coverage/quality-metrics-validate.json');
      break;
    case 'enforce-postgres':
      enforce('coverage/quality-metrics-postgres.json');
      break;
    default:
      throw new Error(
        'Usage: node scripts/quality-dashboard.cjs collect-validate|collect-postgres|aggregate|enforce-validate|enforce-postgres',
      );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Quality dashboard failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseLcov,
  parseTap,
  summarizeComplexity,
  totalCoverage,
  renderSummary,
  readIntegrationSuites,
};

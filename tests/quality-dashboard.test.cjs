'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  parseLcov,
  parseTap,
  summarizeComplexity,
  totalCoverage,
  renderSummary,
  readIntegrationSuites,
} = require('../scripts/quality-dashboard.cjs');

test('LCOV parsing retains per-module line, branch, and function counts', () => {
  const modules = parseLcov(
    [
      'TN:',
      'SF:lib/first.cjs',
      'FNF:2',
      'FNH:1',
      'LF:4',
      'LH:3',
      'BRF:2',
      'BRH:1',
      'end_of_record',
      'SF:lib/second.cjs',
      'FNF:1',
      'FNH:1',
      'LF:2',
      'LH:2',
      'BRF:0',
      'BRH:0',
      'end_of_record',
    ].join('\n'),
  );
  assert.deepEqual(modules, [
    {
      module: 'lib/first.cjs',
      lines: { covered: 3, found: 4, percent: 75 },
      branches: { covered: 1, found: 2, percent: 50 },
      functions: { covered: 1, found: 2, percent: 50 },
    },
    {
      module: 'lib/second.cjs',
      lines: { covered: 2, found: 2, percent: 100 },
      branches: { covered: 0, found: 0, percent: null },
      functions: { covered: 1, found: 1, percent: 100 },
    },
  ]);
  assert.deepEqual(totalCoverage(modules), {
    lines: { covered: 5, found: 6, percent: (5 / 6) * 100 },
    branches: { covered: 1, found: 2, percent: 50 },
    functions: { covered: 2, found: 3, percent: (2 / 3) * 100 },
  });
});

test('TAP parsing reports passed, failed, skipped, and elapsed values', () => {
  assert.deepEqual(
    parseTap(
      [
        'TAP version 13',
        '1..3',
        'ok 1 - first',
        'not ok 2 - second',
        'ok 3 - third # SKIP not applicable',
        '# tests 3',
        '# pass 1',
        '# fail 1',
        '# cancelled 0',
        '# skipped 1',
        '# todo 0',
        '# duration_ms 128.4',
      ].join('\n'),
    ),
    { passed: 1, failed: 1, skipped: 1, elapsedMs: 128.4 },
  );
  assert.equal(parseTap('TAP version 13\n'), null);
});

test('integration metrics preserve each suite outcome when another suite fails', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mailflow-integration-metrics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = (passed, failed, skipped, elapsedMs) =>
    [
      'TAP version 13',
      '# tests 2',
      `# pass ${passed}`,
      `# fail ${failed}`,
      '# cancelled 0',
      `# skipped ${skipped}`,
      '# todo 0',
      `# duration_ms ${elapsedMs}`,
    ].join('\n');
  fs.writeFileSync(path.join(directory, 'persistence-postgres.tap'), report(2, 0, 0, 100));
  fs.writeFileSync(path.join(directory, 'live-persistence-postgres.tap'), report(1, 1, 0, 200));
  fs.writeFileSync(path.join(directory, 'historical-ingestion-postgres.tap'), report(1, 0, 1, 300));
  fs.writeFileSync(
    path.join(directory, 'versioned-persistence-postgres.tap'),
    report(2, 0, 0, 400),
  );

  assert.deepEqual(
    readIntegrationSuites(directory, 'failure').map((suite) => [
      suite.name,
      suite.status,
      suite.passed,
      suite.failed,
      suite.skipped,
      suite.elapsedMs,
    ]),
    [
      ['PostgreSQL persistence', 'success', 2, 0, 0, 100],
      ['Live persistence', 'failure', 1, 1, 0, 200],
      ['Historical ingestion', 'success', 1, 0, 1, 300],
      ['Versioned persistence', 'success', 2, 0, 0, 400],
    ],
  );
});

test('complexity aggregation retains function details and module statistics', () => {
  const functions = [
    {
      module: 'lib/a.cjs',
      line: 4,
      column: 1,
      complexity: 3,
      thresholdViolation: false,
    },
    {
      module: 'lib/a.cjs',
      line: 9,
      column: 1,
      complexity: 22,
      thresholdViolation: true,
    },
    {
      module: 'lib/b.cjs',
      line: 2,
      column: 1,
      complexity: 5,
      thresholdViolation: false,
    },
  ];
  const result = summarizeComplexity(functions);
  assert.deepEqual(result.overall, {
    average: 10,
    maximum: 22,
    functionCount: 3,
    existingThresholdViolations: 1,
  });
  assert.deepEqual(result.modules['lib/a.cjs'], {
    average: 12.5,
    maximum: 22,
    functionCount: 2,
    existingThresholdViolations: 1,
  });
  assert.deepEqual(result.functions, functions);
});

test('dashboard summary clearly marks E2E as not configured', () => {
  const coverageMetric = { covered: 1, found: 2, percent: 50 };
  const markdown = renderSummary({
    run: {
      repository: null,
      runId: null,
      runAttempt: null,
      commitSha: null,
      ref: null,
      workflow: null,
    },
    suites: [
      {
        name: 'E2E',
        category: 'E2E',
        status: 'not_configured',
        passed: null,
        failed: null,
        skipped: null,
        elapsedMs: null,
      },
    ],
    coverage: {
      overall: {
        lines: coverageMetric,
        branches: coverageMetric,
        functions: coverageMetric,
      },
      modules: [
        {
          module: 'lib/example.cjs',
          lines: coverageMetric,
          branches: coverageMetric,
          functions: coverageMetric,
        },
      ],
    },
    complexity: {
      overall: {
        average: 2,
        maximum: 3,
        functionCount: 2,
        existingThresholdViolations: 1,
      },
      modules: {
        'lib/example.cjs': {
          average: 2,
          maximum: 3,
          functionCount: 2,
          existingThresholdViolations: 1,
        },
      },
      functions: [
        {
          module: 'lib/example.cjs',
          line: 4,
          column: 1,
          complexity: 3,
          thresholdViolation: true,
        },
      ],
    },
    qualityGates: { formatting: 'success' },
    diagnostics: [],
  });
  assert.match(markdown, /\| E2E \| E2E \| Not Configured \|/);
  assert.match(markdown, /\| \*\*Overall\*\* \| 50\.0% \(1\/2\) \|/);
  assert.match(markdown, /\| lib\/example\.cjs \| 2 \| 3 \| 2 \| 1 \|/);
  assert.match(markdown, /no coverage or complexity thresholds were added/i);
});

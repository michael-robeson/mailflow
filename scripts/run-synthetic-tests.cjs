'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseLcov, totalCoverage } = require('./quality-dashboard.cjs');

const root = path.resolve(__dirname, '..');
const coverageDirectory = path.join(root, 'coverage');
fs.mkdirSync(coverageDirectory, { recursive: true });
const testFiles = fs
  .readdirSync(path.join(root, 'tests'))
  .filter((file) => file.endsWith('.test.cjs'))
  .sort()
  .map((file) => path.join('tests', file));

const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-include=lib/**/*.cjs',
    '--test-reporter=tap',
    '--test-reporter-destination=coverage/synthetic.tap',
    '--test-reporter=lcov',
    '--test-reporter-destination=coverage/lcov.info',
    ...testFiles,
  ],
  { cwd: root, stdio: 'inherit' },
);

if (result.error) throw result.error;
const tapPath = path.join(coverageDirectory, 'synthetic.tap');
if (fs.existsSync(tapPath)) {
  process.stdout.write(fs.readFileSync(tapPath, 'utf8'));
} else {
  console.error('Test results unavailable: coverage/synthetic.tap was not produced');
}
const lcovPath = path.join(coverageDirectory, 'lcov.info');
if (fs.existsSync(lcovPath)) {
  const modules = parseLcov(fs.readFileSync(lcovPath, 'utf8'));
  const overall = totalCoverage(modules);
  const display = (metric) => (metric.percent === null ? 'N/A' : `${metric.percent.toFixed(2)}%`);
  console.log('\nCoverage by module');
  console.log('| Module | Lines | Branches | Functions |');
  console.log('| --- | ---: | ---: | ---: |');
  console.log(
    `| **Overall** | ${display(overall.lines)} | ${display(overall.branches)} | ${display(overall.functions)} |`,
  );
  for (const module of modules) {
    console.log(
      `| ${module.module} | ${display(module.lines)} | ${display(module.branches)} | ${display(module.functions)} |`,
    );
  }
} else {
  console.error('Coverage report unavailable: coverage/lcov.info was not produced');
}
process.exitCode = result.status ?? 1;

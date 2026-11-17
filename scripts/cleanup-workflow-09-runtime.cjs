'use strict';

const { cleanupRuntime } = require('./prepare-workflow-09-runtime.cjs');

try {
  if (process.argv.length !== 4 || process.argv[3] !== '--confirm') {
    throw new Error('Usage: node scripts/cleanup-workflow-09-runtime.cjs <runtime-dir> --confirm');
  }
  const removed = cleanupRuntime(process.argv[2], true);
  console.log(`Removed workflow 09 temporary assets: ${removed}`);
} catch (error) {
  console.error(`Workflow 09 runtime cleanup refused: ${error.message}`);
  process.exitCode = 1;
}
